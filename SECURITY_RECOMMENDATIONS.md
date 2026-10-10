# Security Recommendations - Mushroom Farm Control

## 🔴 CRITICAL - Implement Immediately

### 1. Generate Cryptographically Strong JWT Secret
**Current Issue:** JWT_SECRET uses a predictable pattern  
**Recommendation:**
```bash
# Generate a secure random secret (run this command):
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Replace in `server/.env`:
```env
JWT_SECRET=<generated-64-byte-hex-string>
```

**Impact:** Prevents token forgery attacks

---

### 2. Remove Credentials from Git History
**Action Required:**
```bash
# Add .env files to .gitignore if not already there
echo "*.env" >> .gitignore
echo "!.env.example" >> .gitignore

# If credentials were already committed:
# 1. Rotate all passwords and secrets
# 2. Consider using git-filter-repo to remove from history
```

**Important:** Change all exposed credentials:
- MQTT broker password
- MongoDB password
- JWT secret
- Admin password

---

### 3. Use Environment-Specific Configuration
Create separate .env files:
- `.env.development` - Local development
- `.env.production` - Production secrets (NEVER commit)
- `.env.example` - Template (safe to commit)

---

## 🟠 HIGH PRIORITY

### 4. Implement Rate Limiting
Add rate limiting to prevent brute force attacks:

```bash
npm install express-rate-limit
```

```typescript
// server/src/middleware/rateLimit.ts
import rateLimit from 'express-rate-limit';

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  message: 'Too many login attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

export const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: 'Too many requests, please slow down',
});
```

Apply to routes:
```typescript
// In auth.ts
router.post("/auth/login", loginLimiter, async (req, res) => { ... });

// In app.ts
app.use("/api", apiLimiter, router);
```

---

### 5. Enable HTTPS in Production
**Never run production without TLS/SSL**

Options:
- Use a reverse proxy (nginx, Caddy) with Let's Encrypt
- Deploy behind a load balancer with SSL termination
- Use Node.js built-in HTTPS module

---

### 6. Add CORS Whitelist
**Current:** CORS allows all origins  
**Recommendation:**

```typescript
// server/src/app.ts
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:5173'],
  credentials: true,
}));
```

Add to `.env`:
```env
ALLOWED_ORIGINS=https://mushroom-farm.example.com,https://www.mushroom-farm.example.com
```

---

## 🟡 MEDIUM PRIORITY

### 7. Implement Helmet for Security Headers
```bash
npm install helmet
```

```typescript
import helmet from 'helmet';
app.use(helmet());
```

---

### 8. Add Input Sanitization
Prevent NoSQL injection:
```bash
npm install express-mongo-sanitize
```

```typescript
import mongoSanitize from 'express-mongo-sanitize';
app.use(mongoSanitize());
```

---

### 9. Enable MongoDB Authentication
Ensure MongoDB is not accessible without credentials:
```
MONGODB_URI=mongodb://username:password@host:port/database?authSource=admin
```

---

### 10. Rotate Secrets Regularly
- JWT secrets every 90 days
- Database passwords every 180 days
- MQTT credentials every 180 days

---

## 🟢 BEST PRACTICES

### 11. Use Secret Management Service
For production, consider:
- **AWS Secrets Manager**
- **HashiCorp Vault**
- **Azure Key Vault**
- **Google Secret Manager**

### 12. Enable Audit Logging
Log all security events:
- Failed login attempts
- Emergency stop activations
- Settings changes
- Relay manual overrides

### 13. Implement Health Checks with Auth
Protect sensitive endpoints even if they're "just" health checks.

### 14. Use CSP Headers
Content Security Policy prevents XSS attacks:
```typescript
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
  },
}));
```

### 15. Regular Security Audits
```bash
# Check for vulnerable dependencies
npm audit

# Use snyk for continuous monitoring
npm install -g snyk
snyk test
```

---

## Environment Variable Checklist

**Never commit these to git:**
- ✅ JWT_SECRET
- ✅ ADMIN_USERNAME  
- ✅ ADMIN_PASSWORD
- ✅ MONGODB_URI
- ✅ MQTT_USERNAME
- ✅ MQTT_PASSWORD

**Safe to commit:**
- ✅ PORT (but use env var in production)
- ✅ NODE_ENV
- ✅ Default configuration values

---

## Emergency Response Plan

If credentials are exposed:

1. **Immediate Actions (< 1 hour)**
   - Rotate all exposed secrets
   - Check logs for unauthorized access
   - Disable compromised accounts

2. **Short Term (< 24 hours)**
   - Review git history
   - Audit recent system changes
   - Notify stakeholders

3. **Long Term (< 1 week)**
   - Implement additional monitoring
   - Review security policies
   - Conduct security training

---

## Compliance Considerations

If handling production mushroom farm data:
- Consider data retention policies
- Implement backup and disaster recovery
- Document security procedures
- Regular penetration testing
- Access control audit trails
