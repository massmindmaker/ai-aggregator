# AI Aggregator Serverless Performance Optimization Guide

## Обзор оптимизаций

Данное руководство содержит оптимизации для решения проблем производительности serverless функций в AI Aggregator, включая cold start времена 5+ секунд, медленные health endpoints, и высокий TTFB (4.9+ секунд).

## Выполненные оптимизации

### 1. Конфигурация Vercel Functions

#### Оптимизированные настройки памяти и времени выполнения:

**D:\webp\aiag\aiaghub\vercel.json:**
- Hub API: увеличена память до 1536MB (было 1024MB)
- Dashboard API: оптимизировано время до 8s (было 10s) 
- Health API: выделена отдельная функция с 256MB и 3s timeout
- Добавлены regions: ["iad1", "fra1", "sfo1"] для глобального покрытия

**D:\webp\aiag\aiag_back\vercel.optimized.json:**
- Main API: увеличена память до 1536MB и timeout до 25s
- Отдельные optimized endpoints для health и keep-alive
- Добавлено кэширование статических ресурсов

### 2. Оптимизация зависимостей

**D:\webp\aiag\aiaghub\package.json:**
```json
{
  "dependencies": {
    "@vercel/kv": "^1.0.1",
    "@vercel/postgres": "^0.5.1", 
    "uuid": "^9.0.0",
    "lru-cache": "^10.0.0",
    "node-cache": "^5.1.2",
    "fast-json-stringify": "^5.8.0",
    "ioredis": "^5.3.2"
  },
  "optionalDependencies": {
    // Moved heavy dependencies to optional
  }
}
```

### 3. Lightweight Health Endpoints

#### Новые оптимизированные health endpoints:

- **D:\webp\aiag\aiaghub\api\health\index.js** - кэшированный health check с TTL 30s
- **D:\webp\aiag\aiag_back\api\health.js** - минимальный health check без database operations
- **D:\webp\aiag\aiaghub\api\edge\health.js** - Edge Runtime версия (<50ms response time)

### 4. Connection Reuse и Кэширование  

#### Оптимизированная connection pool конфигурация:
```javascript
const connectionOptions = {
  maxPoolSize: 5, // Reduced for serverless
  serverSelectionTimeoutMS: 8000,
  socketTimeoutMS: 30000,
  family: 4, // IPv4 only
  bufferMaxEntries: 0,
  bufferCommands: false,
  maxIdleTimeMS: 30000
};
```

#### In-memory кэширование:
```javascript
let cachedApiData = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
```

### 5. Keep-alive механизмы

#### Cron-based warming:
```json
{
  "crons": [
    {
      "path": "/api/keep-alive",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

Keep-alive endpoints:
- **D:\webp\aiag\aiaghub\api\keep-alive\index.js**  
- **D:\webp\aiag\aiag_back\api\keep-alive.js**

### 6. Lazy Loading оптимизации

#### Асинхронная загрузка тяжелых модулей:
```javascript
let database, cache, errorHandler, helpers;

async function loadDependencies() {
  if (!database) {
    const [dbModule, cacheModule, errorModule, helpersModule] = await Promise.all([
      import('../../lib/database.js'),
      import('../../lib/cache.js'),
      // ... other modules
    ]);
  }
}
```

### 7. Edge Runtime Functions

Создана Edge Runtime версия для критических endpoints:
- **D:\webp\aiag\aiaghub\api\edge\health.js** с runtime: 'edge'
- Нет cold start, <50ms response time
- Глобальное покрытие через Vercel Edge Network

### 8. Улучшенные Cache Headers

#### Оптимизированное кэширование по типу контента:
```json
{
  "source": "/(.*\\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot))",
  "headers": [
    {
      "key": "Cache-Control", 
      "value": "public, max-age=31536000, immutable"
    }
  ]
}
```

## Ожидаемые улучшения производительности

### Cold Start сокращение:
- **Было:** 5+ секунд
- **Ожидается:** 1-2 секунды для Node.js functions, <50ms для Edge functions

### Health Endpoints:
- **Было:** медленные ответы из-за тяжелых операций
- **Ожидается:** <100ms с кэшированием, <50ms для Edge версии  

### TTFB сокращение:
- **Было:** 4.9+ секунд
- **Ожидается:** <1 секунда для первого запроса, <500ms для последующих

## Инструкции по внедрению

### 1. Backup текущей конфигурации:
```bash
cp vercel.json vercel.json.backup
```

### 2. Применить оптимизированные конфигурации:
```bash
# Для aiaghub
cp vercel.json vercel.json.old
# Применить изменения из оптимизированной версии

# Для aiag_back  
cp vercel.optimized.json vercel.json
```

### 3. Обновить dependencies:
```bash
npm install --save lru-cache node-cache fast-json-stringify
npm install --save-optional express mongoose cors express-rate-limit
```

### 4. Deploy и тестирование:
```bash
vercel --prod
```

### 5. Мониторинг:
```bash
# Проверить health endpoints
curl https://your-domain.com/api/health
curl https://your-domain.com/api/edge/health

# Мониторить keep-alive logs
vercel logs
```

## Дополнительные рекомендации

### Региональное размещение:
- Используйте `regions: ["iad1", "fra1", "sfo1"]` для покрытия US, Europe, Asia
- Рассмотрите добавление "hnd1" для лучшего покрытия Asia-Pacific

### Bundle size оптимизация:
```bash
# Анализ bundle size
npx @vercel/ncc build api/index.js --minify --source-map
```

### Database connection pooling:
- Рассмотрите использование connection poolers (PgBouncer для PostgreSQL)
- Используйте @vercel/postgres для прямых SQL queries

### Мониторинг производительности:
- Настройте Vercel Analytics и Speed Insights
- Мониторьте Cold Start частоту через keep-alive logs
- Отслеживайте memory usage через health endpoints

## Контрольный список внедрения

- [ ] Backup существующих конфигураций
- [ ] Применить optimized vercel.json configurations  
- [ ] Обновить package.json dependencies
- [ ] Deploy новые health и keep-alive endpoints
- [ ] Настроить cron jobs для warming
- [ ] Протестировать Edge Runtime health endpoint
- [ ] Мониторить performance metrics
- [ ] Настроить alerting для performance degradation

## Файлы для внедрения

Основные файлы для замены/внедрения:

1. **D:\webp\aiag\aiaghub\vercel.json** - обновить согласно оптимизированной версии
2. **D:\webp\aiag\aiag_back\vercel.optimized.json** - переименовать в vercel.json
3. **D:\webp\aiag\aiaghub\api\health\index.js** - новый lightweight health endpoint
4. **D:\webp\aiag\aiag_back\api\health.js** - оптимизированный health endpoint
5. **D:\webp\aiag\aiaghub\api\edge\health.js** - Edge Runtime health endpoint
6. **D:\webp\aiag\aiaghub\api\keep-alive\index.js** - warming endpoint
7. **D:\webp\aiag\aiag_back\api\keep-alive.js** - warming endpoint
8. **D:\webp\aiag\aiaghub\api\hub\[...params].optimized.js** - оптимизированная proxy функция
9. **D:\webp\aiag\aiag_back\api\index.optimized.js** - оптимизированный entry point

После внедрения этих оптимизаций ожидается значительное улучшение производительности serverless функций.