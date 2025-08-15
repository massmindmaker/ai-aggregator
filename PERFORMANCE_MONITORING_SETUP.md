# Performance Monitoring Setup для AI Aggregator

## Мониторинг Cold Start и Performance Metrics

### 1. Настройка Performance Analytics

#### Vercel Analytics Integration:
```javascript
// В главных API endpoints добавить headers для мониторинга
res.setHeader('X-Response-Time-Init', Date.now() - startTime);
res.setHeader('X-Cold-Start', global.isWarm ? 'false' : 'true');
res.setHeader('X-Memory-Usage', Math.round(process.memoryUsage().heapUsed / 1024 / 1024));
res.setHeader('X-Function-Region', process.env.VERCEL_REGION || 'unknown');
```

### 2. Custom Performance Monitoring Endpoint

Создайте monitoring endpoint:

```javascript
// D:\webp\aiag\aiaghub\api\monitoring\performance.js
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();
  const performance = {
    timestamp: new Date().toISOString(),
    coldStart: !global.isWarm,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    region: process.env.VERCEL_REGION,
    
    // Performance metrics
    responseTime: Date.now() - startTime,
    
    // System health
    cpu: process.cpuUsage(),
    platform: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    }
  };

  global.isWarm = true;
  
  return res.status(200).json(performance);
}
```

### 3. Advanced Health Check с Latency Testing

```javascript
// D:\webp\aiag\aiaghub\api\health\advanced.js
export default async function handler(req, res) {
  const startTime = Date.now();
  const { test } = req.query;
  
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    tests: {}
  };

  if (test === 'latency') {
    // Test различных операций
    const latencyTests = await Promise.allSettled([
      testMemoryOperation(),
      testNetworkLatency(),
      testDatabasePing(),
      testCacheOperation()
    ]);

    health.tests = {
      memory: latencyTests[0].status === 'fulfilled' ? latencyTests[0].value : { error: latencyTests[0].reason },
      network: latencyTests[1].status === 'fulfilled' ? latencyTests[1].value : { error: latencyTests[1].reason },
      database: latencyTests[2].status === 'fulfilled' ? latencyTests[2].value : { error: latencyTests[2].reason },
      cache: latencyTests[3].status === 'fulfilled' ? latencyTests[3].value : { error: latencyTests[3].reason }
    };
  }

  health.responseTime = Date.now() - startTime;
  return res.status(200).json(health);
}

async function testMemoryOperation() {
  const start = Date.now();
  const testArray = new Array(10000).fill(0).map((_, i) => i);
  const sum = testArray.reduce((a, b) => a + b, 0);
  return { latency: Date.now() - start, result: sum > 0 };
}

async function testNetworkLatency() {
  const start = Date.now();
  try {
    const response = await fetch('https://httpbin.org/status/200', { 
      method: 'GET',
      timeout: 5000 
    });
    return { 
      latency: Date.now() - start, 
      status: response.status,
      healthy: response.ok 
    };
  } catch (error) {
    return { 
      latency: Date.now() - start, 
      error: error.message,
      healthy: false 
    };
  }
}

async function testDatabasePing() {
  const start = Date.now();
  // Implement database ping here
  return { 
    latency: Date.now() - start, 
    healthy: true,
    note: 'Implement actual database ping' 
  };
}

async function testCacheOperation() {
  const start = Date.now();
  // Test cache write/read
  const testKey = 'health-check-' + Date.now();
  try {
    // Implement cache test
    return { 
      latency: Date.now() - start, 
      healthy: true,
      operation: 'write-read' 
    };
  } catch (error) {
    return { 
      latency: Date.now() - start, 
      healthy: false,
      error: error.message 
    };
  }
}
```

### 4. Automated Performance Testing Script

```bash
#!/bin/bash
# D:\webp\aiag\scripts\performance-test.sh

echo "AI Aggregator Performance Testing"
echo "================================="

# Test URLs
HEALTH_URL="https://your-domain.com/api/health"
EDGE_HEALTH_URL="https://your-domain.com/api/edge/health"
HUB_URL="https://your-hub-domain.com/api/health"

# Function to test endpoint latency
test_endpoint() {
  local url=$1
  local name=$2
  
  echo "Testing $name..."
  
  # Test cold start (multiple requests)
  for i in {1..5}; do
    start_time=$(date +%s%3N)
    response=$(curl -s -w "%{http_code}|%{time_total}" -o /dev/null "$url")
    end_time=$(date +%s%3N)
    
    http_code=$(echo $response | cut -d'|' -f1)
    curl_time=$(echo $response | cut -d'|' -f2)
    total_time=$((end_time - start_time))
    
    echo "  Request $i: HTTP $http_code, Curl time: ${curl_time}s, Total: ${total_time}ms"
  done
  
  echo ""
}

# Test all endpoints
test_endpoint "$HEALTH_URL" "Main Health Endpoint"
test_endpoint "$EDGE_HEALTH_URL" "Edge Health Endpoint"
test_endpoint "$HUB_URL" "Hub Health Endpoint"

# Test with latency details
echo "Detailed latency test..."
curl -s "$HEALTH_URL?detailed=true&test=latency" | jq '.'

echo "Performance test completed."
```

### 5. Vercel CLI Monitoring Commands

```bash
# Мониторинг logs в реальном времени
vercel logs --follow

# Проверка function metrics
vercel inspect https://your-domain.com/api/health

# Анализ performance
vercel ls --scope=your-team

# Environment переменные
vercel env ls
```

### 6. Performance Alerts Setup

Создайте monitoring script для регулярных проверок:

```javascript
// D:\webp\aiag\scripts\performance-monitor.js
const https = require('https');

const ENDPOINTS = [
  'https://your-domain.com/api/health',
  'https://your-hub-domain.com/api/health',
  'https://your-domain.com/api/edge/health'
];

const THRESHOLDS = {
  responseTime: 2000, // 2 seconds
  coldStart: 5000,    // 5 seconds
  errorRate: 0.1      // 10%
};

async function testEndpoint(url) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    const req = https.get(url, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        const endTime = Date.now();
        const responseTime = endTime - startTime;
        
        try {
          const parsed = JSON.parse(data);
          resolve({
            url,
            success: true,
            responseTime,
            statusCode: res.statusCode,
            data: parsed
          });
        } catch (error) {
          resolve({
            url,
            success: false,
            responseTime,
            error: 'Invalid JSON response',
            statusCode: res.statusCode
          });
        }
      });
    });
    
    req.on('error', (error) => {
      resolve({
        url,
        success: false,
        responseTime: Date.now() - startTime,
        error: error.message,
        statusCode: 0
      });
    });
    
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({
        url,
        success: false,
        responseTime: Date.now() - startTime,
        error: 'Timeout',
        statusCode: 0
      });
    });
  });
}

async function runPerformanceCheck() {
  console.log('Starting performance check...', new Date().toISOString());
  
  const results = await Promise.all(ENDPOINTS.map(testEndpoint));
  
  let alerts = [];
  
  results.forEach(result => {
    console.log(`\n${result.url}:`);
    console.log(`  Success: ${result.success}`);
    console.log(`  Response Time: ${result.responseTime}ms`);
    console.log(`  Status Code: ${result.statusCode}`);
    
    if (!result.success) {
      alerts.push(`ALERT: ${result.url} failed - ${result.error}`);
    } else if (result.responseTime > THRESHOLDS.responseTime) {
      alerts.push(`ALERT: ${result.url} slow response - ${result.responseTime}ms`);
    }
    
    if (result.data && result.data.coldStart) {
      console.log(`  Cold Start: ${result.data.coldStart}`);
    }
  });
  
  if (alerts.length > 0) {
    console.log('\n🚨 PERFORMANCE ALERTS:');
    alerts.forEach(alert => console.log(`  ${alert}`));
  } else {
    console.log('\n✅ All endpoints performing within thresholds');
  }
}

// Запуск каждые 5 минут
setInterval(runPerformanceCheck, 5 * 60 * 1000);
runPerformanceCheck(); // Initial run
```

### 7. Dashboard для Real-time Monitoring

```html
<!-- D:\webp\aiag\monitoring\dashboard.html -->
<!DOCTYPE html>
<html>
<head>
  <title>AI Aggregator Performance Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
    .metric-card { border: 1px solid #ddd; padding: 15px; border-radius: 8px; }
    .status-healthy { color: green; }
    .status-degraded { color: orange; }
    .status-unhealthy { color: red; }
  </style>
</head>
<body>
  <h1>AI Aggregator Performance Dashboard</h1>
  
  <div class="metrics">
    <div class="metric-card">
      <h3>Main API Health</h3>
      <p>Status: <span id="main-status">Loading...</span></p>
      <p>Response Time: <span id="main-time">-</span>ms</p>
      <p>Cold Start: <span id="main-coldstart">-</span></p>
    </div>
    
    <div class="metric-card">
      <h3>Hub API Health</h3>
      <p>Status: <span id="hub-status">Loading...</span></p>
      <p>Response Time: <span id="hub-time">-</span>ms</p>
      <p>Cold Start: <span id="hub-coldstart">-</span></p>
    </div>
    
    <div class="metric-card">
      <h3>Edge Function</h3>
      <p>Status: <span id="edge-status">Loading...</span></p>
      <p>Response Time: <span id="edge-time">-</span>ms</p>
      <p>Runtime: <span id="edge-runtime">-</span></p>
    </div>
  </div>
  
  <canvas id="responseTimeChart" width="400" height="200"></canvas>
  
  <script>
    const ENDPOINTS = {
      main: 'https://your-domain.com/api/health',
      hub: 'https://your-hub-domain.com/api/health', 
      edge: 'https://your-domain.com/api/edge/health'
    };
    
    let responseTimeData = {
      labels: [],
      datasets: [{
        label: 'Main API',
        data: [],
        borderColor: 'blue'
      }, {
        label: 'Hub API', 
        data: [],
        borderColor: 'green'
      }, {
        label: 'Edge Function',
        data: [],
        borderColor: 'red'
      }]
    };
    
    const chart = new Chart(document.getElementById('responseTimeChart'), {
      type: 'line',
      data: responseTimeData,
      options: {
        responsive: true,
        title: {
          display: true,
          text: 'Response Time Trends'
        },
        scales: {
          y: {
            beginAtZero: true,
            title: {
              display: true,
              text: 'Response Time (ms)'
            }
          }
        }
      }
    });
    
    async function checkEndpoint(name, url) {
      const startTime = Date.now();
      try {
        const response = await fetch(url);
        const data = await response.json();
        const responseTime = Date.now() - startTime;
        
        updateUI(name, data, responseTime, true);
        return responseTime;
      } catch (error) {
        updateUI(name, null, Date.now() - startTime, false);
        return null;
      }
    }
    
    function updateUI(name, data, responseTime, success) {
      const statusEl = document.getElementById(`${name}-status`);
      const timeEl = document.getElementById(`${name}-time`);
      
      if (success && data) {
        statusEl.textContent = data.status || 'healthy';
        statusEl.className = `status-${data.status || 'healthy'}`;
        timeEl.textContent = responseTime;
        
        if (name === 'main' && data.coldStart !== undefined) {
          document.getElementById('main-coldstart').textContent = data.coldStart;
        }
        if (name === 'hub' && data.coldStart !== undefined) {
          document.getElementById('hub-coldstart').textContent = data.coldStart;
        }
        if (name === 'edge' && data.runtime) {
          document.getElementById('edge-runtime').textContent = data.runtime;
        }
      } else {
        statusEl.textContent = 'unhealthy';
        statusEl.className = 'status-unhealthy';
        timeEl.textContent = responseTime || 'timeout';
      }
    }
    
    async function updateMetrics() {
      const timestamp = new Date().toLocaleTimeString();
      
      const [mainTime, hubTime, edgeTime] = await Promise.all([
        checkEndpoint('main', ENDPOINTS.main),
        checkEndpoint('hub', ENDPOINTS.hub),
        checkEndpoint('edge', ENDPOINTS.edge)
      ]);
      
      // Update chart
      responseTimeData.labels.push(timestamp);
      responseTimeData.datasets[0].data.push(mainTime);
      responseTimeData.datasets[1].data.push(hubTime);
      responseTimeData.datasets[2].data.push(edgeTime);
      
      // Keep only last 10 data points
      if (responseTimeData.labels.length > 10) {
        responseTimeData.labels.shift();
        responseTimeData.datasets.forEach(dataset => dataset.data.shift());
      }
      
      chart.update();
    }
    
    // Update every 30 seconds
    setInterval(updateMetrics, 30000);
    updateMetrics(); // Initial update
  </script>
</body>
</html>
```

### 8. Deployment Commands

```bash
# Deploy с performance monitoring
vercel --prod

# Set up environment variables
vercel env add PERFORMANCE_MONITORING_ENABLED
vercel env add ALERT_WEBHOOK_URL

# Check deployment status
vercel ls

# Monitor logs
vercel logs --follow --since=5m

# Performance inspection
vercel inspect https://your-domain.com
```

Этот setup обеспечит comprehensive мониторинг performance metrics и alerting для serverless функций AI Aggregator.