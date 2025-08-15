# AI Aggregator - Vercel Configuration Summary

## Созданные файлы конфигурации

### 1. Основной проект (aiag_back/)

#### D:\webp\aiag\aiag_back\vercel.json
```json
{
  "version": 2,
  "name": "ai-aggregator",
  "builds": [
    {
      "src": "react-ui/package.json",
      "use": "@vercel/static-build",
      "config": {
        "distDir": "build",
        "buildCommand": "npm run vercel-build"
      }
    },
    {
      "src": "vercel-server.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    // Все API маршруты настроены
    // Статические файлы React
    // SPA routing
  ],
  "functions": {
    "vercel-server.js": {
      "maxDuration": 30
    }
  }
}
```

#### D:\webp\aiag\aiag_back\vercel-server.js
- Адаптированный Express сервер для Vercel Functions
- Оптимизированное подключение к базе данных с кэшированием
- Все API routes подключены
- Статическая раздача React build

#### D:\webp\aiag\aiag_back\.vercelignore
- Исключены dev файлы, node_modules, логи
- Оптимизирован для быстрого деплоя

#### D:\webp\aiag\aiag_back\.env.example
- Шаблон переменных окружения для production

### 2. API Hub (aiaghub/)

#### D:\webp\aiag\aiaghub\vercel.json
```json
{
  "version": 2,
  "name": "aiag-hub",
  "builds": [
    {
      "src": "vercel-server.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    // API маршруты Hub сервиса
  ],
  "functions": {
    "vercel-server.js": {
      "maxDuration": 30
    }
  }
}
```

#### D:\webp\aiag\aiaghub\vercel-server.js
- Адаптированный Express сервер для API Hub
- Serverless-совместимое подключение к БД
- CORS настройки для API

#### D:\webp\aiag\aiaghub\.vercelignore
- Исключены dev файлы и ненужные компоненты

#### D:\webp\aiag\aiaghub\.env.example
- Шаблон переменных окружения для Hub API

### 3. Дополнительные файлы

#### D:\webp\aiag\VERCEL_DEPLOYMENT_GUIDE.md
- Подробное руководство по деплою
- Настройка переменных окружения
- Решение проблем
- Мониторинг и отладка

#### D:\webp\aiag\deploy-scripts.sh
- Автоматизированные скрипты деплоя
- Интерактивное меню для управления
- Проверка статуса и просмотр логов

## Архитектура деплоя

```
Vercel Deployment
├── ai-aggregator.vercel.app (Основное приложение)
│   ├── React Frontend (Static Build)
│   ├── Express Backend (Vercel Function)
│   └── All API Routes (/api/*, /auth/*, etc.)
└── aiag-hub.vercel.app (API Hub)
    ├── Hub API (Vercel Function)
    └── Specialized API Routes
```

## Ключевые особенности конфигурации

### 1. Routing Strategy
- React SPA routing с fallback на index.html
- API routes проксируются на Vercel Functions
- Статические файлы кэшируются с оптимальными headers

### 2. Database Optimization
- Connection pooling для MongoDB
- Кэширование соединений в serverless среде
- Оптимизированные connection settings

### 3. Build Optimization
- React build с NODE_OPTIONS для legacy support
- Исключение dev зависимостей из деплоя
- Оптимизированные static assets

### 4. Security & Performance
- Rate limiting настроен
- CORS правильно сконфигурирован
- Headers для кэширования static content
- Trust proxy для корректной работы с Vercel

## Переменные окружения (обязательные)

### Основной проект
```
MONGO_URI - MongoDB connection string
JWT_SECRET - JWT токен secret
EMAIL_USER, EMAIL_PASS - Email конфигурация
YANDEX_CLOUD_HOST - File storage host
YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY - Payment
NODE_ENV=production
```

### API Hub
```
MONGO_URI - MongoDB connection string
JWT_SECRET - JWT токен secret
PG_HOST, PG_USER, PG_PASSWORD, PG_DATABASE - PostgreSQL
NODE_ENV=production
```

## Команды для деплоя

```bash
# Установка Vercel CLI
npm install -g vercel

# Деплой основного проекта
cd aiag_back && vercel --prod

# Деплой API Hub
cd aiaghub && vercel --prod

# Использование автоматизированного скрипта
chmod +x deploy-scripts.sh
./deploy-scripts.sh
```

## Мониторинг

```bash
# Просмотр логов
vercel logs ai-aggregator
vercel logs aiag-hub

# Статус deployments
vercel ls

# Локальная разработка
vercel dev
```

## Результат

После успешного деплоя:
- ✅ React приложение доступно как SPA
- ✅ Все API endpoints работают через Vercel Functions
- ✅ Статические файлы кэшируются оптимально
- ✅ Database connections оптимизированы для serverless
- ✅ API Hub работает как отдельный сервис
- ✅ Production-ready конфигурация

Все файлы готовы для деплоя на Vercel без дополнительных изменений.