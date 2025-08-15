# AI Aggregator Database Migration Guide

Полное руководство по миграции AI Aggregator на MongoDB Atlas и Vercel Postgres для развертывания на Vercel.

## Оглавление

1. [Обзор миграции](#обзор-миграции)
2. [Подготовка к миграции](#подготовка-к-миграции)
3. [MongoDB Atlas настройка](#mongodb-atlas-настройка)
4. [Vercel Postgres настройка](#vercel-postgres-настройка)
5. [Выполнение миграции](#выполнение-миграции)
6. [Настройка переменных окружения](#настройка-переменных-окружения)
7. [Тестирование](#тестирование)
8. [Развертывание](#развертывание)
9. [Мониторинг и обслуживание](#мониторинг-и-обслуживание)
10. [Устранение неполадок](#устранение-неполадок)

## Обзор миграции

### Текущее состояние
- **MongoDB**: Локальный на `84.201.185.11` с базой `app`
- **PostgreSQL**: Локальный на `localhost:5432` с базой `apihubdb`

### Целевое состояние
- **MongoDB Atlas**: Облачная база данных для основного приложения
- **Vercel Postgres**: Serverless PostgreSQL для API Hub метрик

### Структура файлов миграции
```
database/
├── mongodb/
│   ├── atlas-config.js       # Конфигурация MongoDB Atlas
│   ├── indexes.js            # Оптимизированные индексы
│   └── migration-script.js   # Скрипт миграции данных
├── postgres/
│   ├── vercel-config.js      # Конфигурация Vercel Postgres
│   ├── vercel-schema.sql     # SQL схема для Vercel
│   └── migration-script.js   # Скрипт миграции PostgreSQL
├── config/
│   └── database-adapter.js   # Универсальный адаптер
└── healthcheck/
    ├── endpoints.js          # Health check API
    └── monitoring.js         # Мониторинг баз данных
```

## Подготовка к миграции

### 1. Установка зависимостей

```bash
# Основные зависимости для миграции
npm install mongoose pg

# Для развертывания на Vercel
npm install @vercel/node

# Дополнительные утилиты
npm install dotenv config
```

### 2. Резервное копирование

#### MongoDB
```bash
# Создание резервной копии MongoDB
mongodump --uri="mongodb://Aexa:FH8238fdisdf4738fas9ada9sryeuirw@84.201.185.11/app?authSource=admin" --out=./backup/mongodb

# Архивация
tar -czf mongodb-backup-$(date +%Y%m%d).tar.gz ./backup/mongodb
```

#### PostgreSQL
```bash
# Создание резервной копии PostgreSQL
pg_dump -h localhost -U postgres -d apihubdb > ./backup/postgres-backup-$(date +%Y%m%d).sql

# Сжатие
gzip ./backup/postgres-backup-$(date +%Y%m%d).sql
```

## MongoDB Atlas настройка

### 1. Создание кластера

1. Войдите в [MongoDB Atlas](https://cloud.mongodb.com/)
2. Создайте новый проект "AI-Aggregator-Production"
3. Создайте кластер:
   - **Tier**: M0 (Free) или M2/M5 для production
   - **Provider**: AWS/Google Cloud/Azure
   - **Region**: Ближайший к пользователям (Europe-West для РФ)
   - **Cluster Name**: `ai-aggregator-cluster`

### 2. Настройка безопасности

#### Создание пользователя базы данных
```javascript
// Пользователь: aiag-app-user
// Пароль: [Сгенерировать надежный пароль]
// Роли: readWrite на базе app
```

#### Настройка IP Whitelist
```
0.0.0.0/0  # Для Vercel (все IP)
```

### 3. Получение connection string
```
mongodb+srv://aiag-app-user:[PASSWORD]@ai-aggregator-cluster.xxxxx.mongodb.net/app?retryWrites=true&w=majority
```

### 4. Запуск миграции MongoDB

```bash
# Установка переменных окружения
export MONGODB_ATLAS_URI="mongodb+srv://aiag-app-user:[PASSWORD]@ai-aggregator-cluster.xxxxx.mongodb.net/app?retryWrites=true&w=majority"

# Запуск миграции
cd database/mongodb
node migration-script.js migrate

# Проверка результатов
node migration-script.js verify
```

### 5. Создание индексов

```bash
# Создание оптимизированных индексов
node -e "
const { createIndexes } = require('./database/mongodb/indexes');
const mongoAtlas = require('./database/mongodb/atlas-config');

async function setup() {
  await mongoAtlas.connect();
  await createIndexes();
  await mongoAtlas.disconnect();
  console.log('Indexes created successfully');
}

setup().catch(console.error);
"
```

## Vercel Postgres настройка

### 1. Создание базы данных в Vercel

```bash
# Установка Vercel CLI
npm install -g vercel

# Логин в Vercel
vercel login

# Создание Postgres базы
vercel postgres create ai-aggregator-hub
```

### 2. Получение connection string

```bash
# Получение переменных окружения
vercel env ls

# Connection string будет в формате:
# postgres://username:password@hostname:5432/database
```

### 3. Запуск миграции схемы

```bash
# Установка переменных окружения
export POSTGRES_URL="postgres://username:password@hostname:5432/database"

# Создание схемы
cd database/postgres
node migration-script.js schema

# Миграция данных
node migration-script.js migrate

# Проверка
node migration-script.js verify
```

## Выполнение миграции

### 1. Подготовка окружения

Создайте файл `.env.migration`:

```bash
# MongoDB Atlas
MONGODB_ATLAS_URI=mongodb+srv://aiag-app-user:[PASSWORD]@ai-aggregator-cluster.xxxxx.mongodb.net/app?retryWrites=true&w=majority

# Vercel Postgres
POSTGRES_URL=postgres://username:password@hostname:5432/database

# Опции миграции
FORCE_MIGRATION=false
BATCH_SIZE=1000
```

### 2. Запуск полной миграции

```bash
# Загрузка переменных окружения
source .env.migration

# Полная миграция MongoDB
cd database/mongodb
node migration-script.js migrate

# Полная миграция PostgreSQL
cd ../postgres
node migration-script.js migrate

# Создание sample данных
node migration-script.js sample
```

### 3. Проверка миграции

```bash
# Запуск скрипта проверки
node -e "
const { getDatabaseAdapter } = require('./database/config/database-adapter');

async function verify() {
  const adapter = getDatabaseAdapter();
  const health = await adapter.healthCheck();
  const migrations = await adapter.testMigrations();
  
  console.log('Health Check:', health);
  console.log('Migrations:', migrations);
  
  await adapter.shutdown();
}

verify().catch(console.error);
"
```

## Настройка переменных окружения

### 1. Для разработки (.env.local)

```bash
# MongoDB Atlas
MONGODB_ATLAS_URI=mongodb+srv://aiag-app-user:[PASSWORD]@ai-aggregator-cluster.xxxxx.mongodb.net/app?retryWrites=true&w=majority

# Vercel Postgres
POSTGRES_URL=postgres://username:password@hostname:5432/database

# Другие настройки
NODE_ENV=development
JWT_SECRET=y2783y7820ry8920fu79q20yf7830y27f78q0273fhh792f839q
VERCEL_URL=http://localhost:3000

# Мониторинг
DB_MONITORING_ENABLED=true
```

### 2. Для Vercel (Production)

```bash
# Установка переменных в Vercel
vercel env add MONGODB_ATLAS_URI production
vercel env add POSTGRES_URL production
vercel env add JWT_SECRET production
vercel env add NODE_ENV production

# Или через веб-интерфейс Vercel Dashboard
```

### 3. Обновление конфигурационных файлов

#### aiag_back/config/production.json
```json
{
    "port": 5000,
    "jwtSecret": "${JWT_SECRET}",
    "mongoUri": "${MONGODB_ATLAS_URI}",
    "baseUrl": "${VERCEL_URL}"
}
```

#### aiaghub/config/production.json
```json
{
    "port": 5000,
    "jwtSecret": "${JWT_SECRET}",
    "baseUrl": "${VERCEL_URL}",
    "database": {
        "postgres": {
            "connectionString": "${POSTGRES_URL}"
        }
    }
}
```

## Тестирование

### 1. Локальное тестирование

```bash
# Запуск приложения с новыми базами данных
cd aiag_back
NODE_ENV=production npm start

# В другом терминале
cd aiaghub
NODE_ENV=production npm start
```

### 2. Тестирование подключений

```bash
# Тест MongoDB
curl http://localhost:5000/health/mongodb

# Тест PostgreSQL
curl http://localhost:5000/health/postgresql

# Общий health check
curl http://localhost:5000/health
```

### 3. Функциональные тесты

```javascript
// test/database-migration.test.js
const { getDatabaseAdapter } = require('../database/config/database-adapter');

describe('Database Migration Tests', () => {
  let adapter;
  
  beforeAll(async () => {
    adapter = getDatabaseAdapter();
    await adapter.initialize();
  });
  
  afterAll(async () => {
    await adapter.shutdown();
  });
  
  test('MongoDB connection should be healthy', async () => {
    const mongo = await adapter.getMongoDB();
    const health = await mongo.healthCheck();
    expect(health.status).toBe('connected');
  });
  
  test('PostgreSQL connection should be healthy', async () => {
    const postgres = await adapter.getPostgreSQL();
    const health = await postgres.healthCheck();
    expect(health.status).toBe('connected');
  });
  
  test('Cross-database analytics should work', async () => {
    const { dbOperations } = require('../database/config/database-adapter');
    const analytics = await dbOperations.getCrossDbAnalytics();
    expect(analytics).toHaveProperty('mongodb');
    expect(analytics).toHaveProperty('postgresql');
  });
});
```

## Развертывание

### 1. Подготовка к развертыванию

```bash
# Обновление vercel.json в корне проекта
{
  "version": 2,
  "builds": [
    {
      "src": "aiag_back/vercel-server.js",
      "use": "@vercel/node"
    },
    {
      "src": "aiaghub/vercel-server.js", 
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/api/hub/(.*)",
      "dest": "/aiaghub/vercel-server.js"
    },
    {
      "src": "/(.*)",
      "dest": "/aiag_back/vercel-server.js"
    }
  ],
  "env": {
    "MONGODB_ATLAS_URI": "@mongodb-atlas-uri",
    "POSTGRES_URL": "@postgres-url",
    "JWT_SECRET": "@jwt-secret"
  }
}
```

### 2. Развертывание на Vercel

```bash
# Развертывание
vercel --prod

# Проверка статуса
vercel ls

# Логи
vercel logs [deployment-url]
```

### 3. Проверка production развертывания

```bash
# Health checks
curl https://your-deployment.vercel.app/health
curl https://your-deployment.vercel.app/health/detailed
curl https://your-deployment.vercel.app/health/mongodb
curl https://your-deployment.vercel.app/health/postgresql
```

## Мониторинг и обслуживание

### 1. Настройка мониторинга

```javascript
// Добавление в main server file
const { getGlobalMonitor } = require('./database/healthcheck/monitoring');

// Запуск мониторинга
const monitor = getGlobalMonitor();
monitor.start();

// События мониторинга
monitor.on('alert', (alert) => {
  console.error('Database Alert:', alert);
  // Интеграция с внешними системами (Slack, email и т.д.)
});
```

### 2. Health check endpoints

```
GET /health              - Общий статус
GET /health/detailed     - Подробная информация
GET /health/mongodb      - Статус MongoDB
GET /health/postgresql   - Статус PostgreSQL
GET /health/performance  - Тесты производительности
GET /health/analytics    - Аналитика использования
GET /health/ready        - Kubernetes readiness probe
GET /health/live         - Kubernetes liveness probe
```

### 3. Регулярное обслуживание

```javascript
// Скрипт очистки старых данных
// scripts/cleanup.js
const { dbUtils } = require('../database/postgres/vercel-config');

async function cleanupOldData() {
  // Удаление запросов старше 1 года
  await dbUtils.query(`
    DELETE FROM request 
    WHERE date < NOW() - INTERVAL '1 year'
  `);
  
  // Удаление старых hourly stats
  await dbUtils.query(`
    DELETE FROM hourly_request_stats 
    WHERE hour < NOW() - INTERVAL '30 days'
  `);
  
  console.log('Cleanup completed');
}

// Запуск через cron или Vercel Cron Jobs
```

### 4. Бэкапы

```javascript
// scripts/backup.js
const mongoAtlas = require('../database/mongodb/atlas-config');
const { dbUtils } = require('../database/postgres/vercel-config');

async function createBackups() {
  // MongoDB backup через Atlas UI или API
  // PostgreSQL backup через Vercel API
  
  console.log('Backups created');
}
```

## Устранение неполадок

### Частые проблемы и решения

#### 1. Connection timeout
```bash
# Проверка переменных окружения
echo $MONGODB_ATLAS_URI
echo $POSTGRES_URL

# Тест подключения
node -e "
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_ATLAS_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));
"
```

#### 2. SSL Certificate issues
```javascript
// Добавить в конфигурацию MongoDB
{
  ssl: true,
  sslValidate: false  // Только для тестирования
}

// Для PostgreSQL
{
  ssl: { rejectUnauthorized: false }
}
```

#### 3. Connection pool exhaustion
```javascript
// Проверка статуса пула
const { getPostgresConnection } = require('./database/postgres/vercel-config');
const postgres = getPostgresConnection();
console.log('Pool stats:', postgres.getPoolStats());
```

#### 4. Migration failures
```bash
# Откат миграции MongoDB
node database/mongodb/migration-script.js rollback

# Откат миграции PostgreSQL
node database/postgres/migration-script.js rollback

# Принудительная миграция
FORCE_MIGRATION=true node database/mongodb/migration-script.js migrate
```

### Диагностические команды

```bash
# Проверка здоровья всех систем
curl -s https://your-app.vercel.app/health/detailed | jq '.'

# Проверка метрик производительности
curl -s https://your-app.vercel.app/health/performance | jq '.'

# Проверка миграций
curl -s https://your-app.vercel.app/health/migrations | jq '.'
```

### Контакты для поддержки

- **MongoDB Atlas Support**: https://support.mongodb.com/
- **Vercel Support**: https://vercel.com/support
- **Документация проекта**: Этот файл и код комментарии

## Заключение

После успешной миграции:

1. ✅ MongoDB Atlas обеспечивает надежное хранение основных данных
2. ✅ Vercel Postgres оптимизирован для API метрик
3. ✅ Connection pooling настроен для serverless
4. ✅ Health monitoring активен
5. ✅ Система готова к production нагрузкам

Следующие шаги:
- Настройка CI/CD pipeline
- Мониторинг производительности
- Оптимизация на основе метрик использования
- Масштабирование по мере роста нагрузки