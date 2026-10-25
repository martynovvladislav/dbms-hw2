// Заполняйте TODO. c — переданная база; функции выполняют реальные запросы MongoDB.
// Служебный lab.js менять не требуется. Контракты и порядок опытов — в Задание.md.
globalThis.installValidator = async c => {
  return c.runCommand({
    collMod: 'products',
    validator: {
      $and: [
        {
          $jsonSchema: {
            bsonType: 'object',
            required: ['_id', 'name', 'category', 'price', 'variants'],
            properties: {
              _id: {bsonType: 'string'},
              name: {bsonType: 'string'},
              category: {bsonType: 'string'},
              price: {bsonType: 'decimal', minimum: 0},
              variants: {
                bsonType: 'array',
                items: {
                  bsonType: 'object',
                  required: ['size', 'stock'],
                  properties: {
                    size: {bsonType: 'string'},
                    stock: {bsonType: ['int', 'long'], minimum: 0}
                  }
                }
              }
            }
          }
        },
        {
          $expr: {
            $cond: [
              {$isArray: '$variants'},
              {
                $eq: [
                  {$size: '$variants'},
                  {$size: {$setUnion: [
                    {$map: {input: '$variants', as: 'variant', in: '$$variant.size'}},
                    []
                  ]}}
                ]
              },
              false
            ]
          }
        }
      ]
    },
    validationLevel: 'strict',
    validationAction: 'error'
  });
};

// Возврат: Promise массива полных Product; порядок _id ASC; [] при отсутствии.
globalThis.searchProducts = async (c, {category, size, qty}) => {
  return c.products.find({
    category,
    variants: {$elemMatch: {size, stock: {$gte: qty}}}
  })
    .collation({locale: 'simple'})
    .sort({_id: 1})
    .toArray();
};

// Технический helper: верните MongoDB cursor с фильтром, сортировкой и limit.
// Один и тот же запрос используется для результата и explain в опыте с индексом.
globalThis.historyCursor = (c, {userId, status}) => {
  return c.orders.find({
    userId,
    status
  })
    .sort({createdAt: -1, _id: 1})
    .limit(20);
};
globalThis.history = async (c, input) => historyCursor(c, input).toArray();

// Заполните порядок полей и направления индекса для historyCursor.
globalThis.historyIndex = {
  userId: 1,
  status: 1,
  createdAt: -1,
  _id: 1
};
// Если добавили hint в historyCursor, измените флаг на true.
globalThis.usesHistoryHint = false;

// Возврат: Promise массива {sku, name, qty, revenue}; revenue — Decimal128.
globalThis.report = async (c, from, to) => {
  return c.orders.aggregate([
    {
      $match: {
        status: "paid",
        createdAt: {$gte: from, $lt: to}
      }
    },
    {
      $unwind: "$items"
    },
    {
      $group: {
        _id: "$items.sku",
        qty: {$sum: "$items.qty"},
        revenue: {$sum: {$multiply: ["$items.qty", "$items.price"]}}
      }
    },
    {
      $sort: {revenue: -1, _id: 1}
    },
    {
      $limit: 5
    },
    {
      $lookup: {
        from: "products",
        localField: "_id",
        foreignField: "_id",
        as: "product"
      }
    },
    {
      $unwind: "$product"
    },
    {
      $project: {
        _id: 0,
        sku: "$_id",
        name: "$product.name",
        qty: 1,
        revenue: 1
      }
    }
  ], {collation: {locale: "simple"}}).toArray();
};

// request: {operationId, userId, items:[{sku,size,qty},{sku,size,qty}]}.
// Входы соответствуют контракту задания. Два SKU различны; порядок items значим.
// Возврат: Promise созданного или ранее сохранённого Order.
// При отказе: throw HWError('ITEM_UNAVAILABLE') или HWError('REQUEST_CONFLICT').
// Сообщение ошибки свободное; сценарий проверяет только error.code.
// transaction(body) предоставлена: body получает c — базу в активной сессии.
// Все операции покупки внутри body выполняйте через этот c.
globalThis.purchase = async (request, trace = () => {}) => {
  return transaction(async c => {
    const existing = await c.orders.findOne({_id: request.operationId});

    if (existing) {
      const isSameRequest = Number(existing.userId) === request.userId &&
        existing.items.length === request.items.length &&
        existing.items.every((item, index) => {
          const requestItem = request.items[index];
          return item.sku === requestItem.sku && item.size === requestItem.size && Number(item.qty) === requestItem.qty;
        });

      if (!isSameRequest) {
        throw HWError('REQUEST_CONFLICT');
      }

      return existing;
    }

    const items = [];
    for (const item of request.items) {
      const product = await c.products.findOne({_id: item.sku});
      if (!product) {
        throw HWError('ITEM_UNAVAILABLE');
      }

      const r = await c.products.updateOne(
        {
          _id: item.sku,
          variants: {$elemMatch: {size: item.size, stock: {$gte: item.qty}}}
        },
        {$inc: {'variants.$.stock': -item.qty}}
      );

      trace({
        event: 'update_inside_transaction',
        sku: item.sku,
        matched: r.matchedCount,
        modified: r.modifiedCount
      });

      if (r.matchedCount !== 1) {
        throw HWError('ITEM_UNAVAILABLE');
      }

      items.push({
        sku: item.sku,
        size: item.size,
        qty: NumberInt(item.qty),
        price: product.price
      });
    }

    const order = {
      _id: request.operationId,
      userId: NumberInt(request.userId),
      createdAt: new Date(),
      status: 'created',
      items
    };

    await c.orders.insertOne(order);
    return order;
  });
};

// Используйте именно переданный c: он связан с одним MongoDB-клиентом опыта.
// writeProbe: сохранить {_id:id, message} в c.probe с majority и j:true.
// Возврат — результат записи с acknowledged:true. Повтор вызова с тем же id
// должен быть безопасен: оболочка опыта может повторить запись после ошибки связи.
globalThis.writeProbe = async (c, id, message) => {
  return c.probe.updateOne(
    {_id: id},
    {$set: {message}},
    {
      upsert: true,
      writeConcern: {w: 'majority', j: true, wtimeout: 10000}
    }
  );
};
// Возврат — документ c.probe с указанным _id либо null.
globalThis.readProbe = async (c, id) => {
  return c.probe.findOne({_id: id});
};

