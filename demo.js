// Просмотр фактических сохранённых результатов. Запросы к базе не выполняются.
(function () {
  const fs = require('fs');
  const results = EJSON.parse(fs.readFileSync('/out/results.json', 'utf8'), {relaxed: false});
  const part = process.env.DEMO_PART || 'summary';
  const hash = require('crypto').createHash('sha256')
    .update(fs.readFileSync('/work/solution.js')).digest('hex');
  const data = results.scenarios.data?.artifacts?.data;
  const index = results.scenarios.index?.artifacts?.index;
  const purchase = results.scenarios.purchase?.artifacts?.purchase;
  const failover = results.scenarios.failover?.artifacts?.failover;

  function text(value) {
    if (value === undefined || value === null) return '-';
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }

  function json(title, value) {
    print('\n' + title);
    print(EJSON.stringify(value, null, 2, {relaxed: true}));
  }

  function table(title, columns, rows) {
    print('\n' + title);
    if (!rows.length) { print('[]'); return; }
    const cells = rows.map(row => columns.map(key => text(row[key])));
    const widths = columns.map((key, i) => Math.max(key.length, ...cells.map(row => row[i].length)));
    const line = row => row.map((value, i) => value.padEnd(widths[i])).join(' | ');
    print(line(columns));
    print(widths.map(width => '-'.repeat(width)).join('-+-'));
    cells.forEach(row => print(line(row)));
  }

  function requireScenario(name) {
    const scenario = results.scenarios[name];
    if (!scenario || scenario.status !== 'passed' || scenario.solutionHash !== hash) {
      throw new Error('Нет актуального успешного результата ' + name + '. Выполните docker compose run --rm lab all');
    }
    print('\nИсточник: scenarios.' + name + '.artifacts в results/results.json');
    print('Результат получен командой: docker compose run --rm lab ' + name);
    print('Время начала опыта (UTC): ' + text(scenario.startedAt));
  }

  // Выбираем исходный фрагмент ошибки MongoDB, сохраняя его поля и значения.
  function findPropertyError(value, name) {
    if (!value || typeof value !== 'object') return null;
    if (value.propertyName === name) return value;
    for (const child of Object.values(value)) {
      const found = findPropertyError(child, name);
      if (found) return found;
    }
    return null;
  }

  function stages(plan) {
    const found = new Set();
    function visit(value) {
      if (!value || typeof value !== 'object') return;
      if (value.stage) found.add(value.stage);
      Object.values(value).forEach(visit);
    }
    visit(plan);
    return [...found].join(', ');
  }

  function stock(state, item) {
    return state.products.find(product => product._id === item.sku)
      .variants.find(variant => variant.size === item.size).stock;
  }

  function reportRows(title, rows) {
    table(title, ['sku', 'name', 'qty', 'revenue'], rows);
  }

  const sections = {
    summary() {
      table('Сценарии', ['scenario', 'status', 'checks', 'currentCode'],
        ['data', 'index', 'purchase', 'failover'].map(name => {
          const scenario = results.scenarios[name];
          return {scenario: name, status: scenario?.status, checks: scenario?.checks?.length,
            currentCode: scenario?.solutionHash === hash};
        }));
    },
    data() {
      requireScenario('data');
      json('Режим валидатора', {
        validationLevel: data.options.validationLevel,
        validationAction: data.options.validationAction
      });
      table('Результаты вставок', ['document', 'code', 'result'], data.validation.map(row => ({
        document: row.id, code: row.code, result: Number(row.code) === 0 ? 'ACCEPTED' : 'REJECTED'
      })));
      const priceError = data.validation.find(row => row.id === 'string-price');
      const stockError = data.validation.find(row => row.id === 'negative-stock');
      json('Причина отказа строковой цены: фрагмент errInfo MongoDB',
        findPropertyError(priceError.details, 'price') || priceError.details);
      json('Причина отказа отрицательного остатка: фрагмент errInfo MongoDB',
        findPropertyError(stockError.details, 'stock') || stockError.details);
      table('Поиск товаров', ['category', 'size', 'qty', 'change', 'found'], data.searches.map(row => ({
        category: row.category, size: row.size, qty: row.qty, change: row.afterChange,
        found: '[' + row.found.join(', ') + ']'
      })));
      const initialSearch = data.searches.find(row => row.category === 'clothes' && row.size === 'M' && Number(row.qty) === 5);
      const changedSearch = data.searches.find(row => row.afterChange);
      json('Полный товар A до изменения: сохранён в результате поиска clothes/M/5',
        initialSearch.documents.find(product => product._id === 'A'));
      json('Полный товар A после изменения L=2: из повторного поиска clothes/L/2',
        changedSearch.documents.find(product => product._id === 'A'));
      table('История: userId=2500, status=paid', ['position', 'id', 'createdAt'],
        data.history.map((order, i) => ({position: i + 1, id: order._id, createdAt: order.createdAt})));
      json('Пример полного заказа из истории', data.history[0]);
      table('Дополнительные случаи истории', ['userId', 'status', 'ids'], [
        {userId: 2501, status: 'paid', ids: '[' + data.otherUser.map(order => order._id).join(', ') + ']'},
        {userId: 2500, status: 'cancelled', ids: '[' + data.otherStatus.map(order => order._id).join(', ') + ']'},
        {userId: 9999, status: 'paid', ids: '[' + data.noHistory.map(order => order._id).join(', ') + ']'}
      ]);
    },
    report() {
      requireScenario('data');
      json('Период отчёта [from, to)', data.reportParameters);
      reportRows('Топ-5 оплаченных товаров', data.report);
      json('Проверка включения from: период', {from: data.boundaryReport.from, to: data.boundaryReport.to});
      reportRows('Результат на начальной границе', data.boundaryReport.rows);
      json('Пустой период', data.emptyReport);
      json('Изменённая текущая цена каталога', data.afterPriceReport.changedProduct);
      reportRows('Отчёт после изменения цены', data.afterPriceReport.rows);
    },
    index() {
      requireScenario('index');
      json('Фильтр, сортировка и составной индекс', {
        filter: index.filter, sort: index.sort, index: index.index, hint: index.hint
      });
      table('Сравнение планов', ['variant', 'nReturned', 'keys', 'documents', 'SORT', 'stages'],
        ['before', 'after'].map(variant => ({
          variant, nReturned: index[variant].nReturned, keys: index[variant].totalKeysExamined,
          documents: index[variant].totalDocsExamined, SORT: index[variant].hasSORT,
          stages: stages(results.scenarios.index.artifacts['explain-' + variant].queryPlanner.winningPlan)
        })));
      json('Победивший план до индекса', results.scenarios.index.artifacts['explain-before'].queryPlanner.winningPlan);
      json('Победивший план после индекса', results.scenarios.index.artifacts['explain-after'].queryPlanner.winningPlan);
      table('Выдача до и после', ['position', 'before', 'after'],
        index.beforeIds.map((id, i) => ({position: i + 1, before: id, after: index.afterIds[i]})));
    },
    plans() {
      requireScenario('index');
      json('Полный explain до индекса', results.scenarios.index.artifacts['explain-before']);
      json('Полный explain после индекса', results.scenarios.index.artifacts['explain-after']);
    },
    purchase() {
      requireScenario('purchase');
      json('Запрос с нехваткой второго товара', purchase.rollback.request);
      table('Реальные обновления внутри транзакции до abort', ['sku', 'matched', 'modified'], purchase.rollback.trace);
      table('Остатки выбранных вариантов', ['sku', 'size', 'before', 'afterAbort', 'afterSuccess', 'afterReplay', 'afterConflict'],
        purchase.request.items.map(item => ({
          sku: item.sku, size: item.size, before: stock(purchase.rollback.before, item),
          afterAbort: stock(purchase.rollback.after, item), afterSuccess: stock(purchase.success.state, item),
          afterReplay: stock(purchase.replay.after, item), afterConflict: stock(purchase.conflict.after, item)
        })));
      table('Число заказов', ['stage', 'count', 'ids'], [
        ['before', purchase.rollback.before], ['afterAbort', purchase.rollback.after],
        ['afterSuccess', purchase.success.state], ['afterReplay', purchase.replay.after],
        ['afterConflict', purchase.conflict.after]
      ].map(([stage, state]) => ({stage, count: state.orders.length, ids: '[' + state.orders.map(order => order._id).join(', ') + ']'})));
      json('Запрос успешной покупки', purchase.request);
      json('Сохранённый заказ', purchase.success.order);
      const catalogBeforeReplay = purchase.replay.before.products.find(product => product._id === purchase.request.items[0].sku);
      json('Текущая цена каталога перед повтором покупки', {
        sku: catalogBeforeReplay._id, price: catalogBeforeReplay.price
      });
      table('Успех и повтор: дата и цены', ['call', 'id', 'createdAt', 'prices'], [
        ['success', purchase.success.order], ['replay', purchase.replay.order]
      ].map(([call, order]) => ({call, id: order._id, createdAt: order.createdAt,
        prices: order.items.map(item => text(item.price)).join(', ')})));
      table('Ошибки', ['case', 'code'], [
        {case: 'insufficient stock', code: purchase.rollback.error},
        {case: 'changed request', code: purchase.conflict.error},
        {case: 'missing size', code: purchase.missingError},
        {case: 'unknown SKU', code: purchase.unknownError}
      ]);
    },
    transactions() {
      requireScenario('purchase');
      table('Разности счётчиков транзакций', ['experiment', 'started', 'committed', 'aborted', 'sameProcess'],
        ['rollback', 'success'].map(experiment => {
          const evidence = results.scenarios.purchase.artifacts['transactions-' + experiment];
          return {experiment, started: evidence.delta.totalStarted, committed: evidence.delta.totalCommitted,
            aborted: evidence.delta.totalAborted, sameProcess: evidence.sameProcess};
        }));
      for (const experiment of ['rollback', 'success']) {
        const evidence = results.scenarios.purchase.artifacts['transactions-' + experiment];
        table('Метаданные процесса: ' + experiment, ['snapshot', 'host', 'pid', 'localTime', 'uptime'],
          ['before', 'after'].map(snapshot => ({snapshot, host: evidence[snapshot].host,
            pid: evidence[snapshot].pid, localTime: evidence[snapshot].localTime, uptime: evidence[snapshot].uptime})));
      }
    },
    snapshots() {
      requireScenario('purchase');
      json('Полные снимки: откат', results.scenarios.purchase.artifacts['transactions-rollback']);
      json('Полные снимки: успех', results.scenarios.purchase.artifacts['transactions-success']);
    },
    failover() {
      requireScenario('failover');
      json('Подключение и параметры', {
        connection: failover.connection, writeConcern: failover.writeConcern, sameClient: failover.sameClient
      });
      table('Роли до и после stepDown', ['host', 'before', 'after'], failover.before.map(member => ({
        host: member.host, before: member.role, after: failover.after.find(after => after.host === member.host).role
      })));
      json('Первая запись', failover.firstWrite);
      json('Результат stepDown', failover.stepDown);
      json('Повторные попытки во время переключения', failover.retries);
      json('Прочитанный прежний документ', failover.read);
      json('Новая запись', failover.newWrite);
      json('Оба документа после переключения', failover.documents);
    }
  };

  print('СОХРАНЁННЫЕ РЕЗУЛЬТАТЫ: results/results.json');
  print('Время сохранения (UTC): ' + text(results.updatedAt));
  print('Команда получения полного прогона: docker compose run --rm lab all');
  print('Таблицы и JSON ниже показывают сохранённые данные; BSON-типы полностью сохранены в исходном results.json.');
  if (part === 'all') {
    for (const name of ['summary', 'data', 'report', 'index', 'purchase', 'transactions', 'failover']) sections[name]();
  } else if (Object.hasOwn(sections, part)) {
    sections[part]();
  } else {
    throw new Error('Неизвестный DEMO_PART. Допустимы: ' + Object.keys(sections).join(', ') + ', all');
  }
})();
