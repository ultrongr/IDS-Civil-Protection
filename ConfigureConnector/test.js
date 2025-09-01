import axios from 'axios';
import https from 'https';
import dotenv from 'dotenv';
dotenv.config({ path: 'ameaclub.env' });

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const provider = axios.create({
  baseURL: process.env.PROVIDER_URL,      // e.g. https://localhost:8083
  httpsAgent,
  auth: {
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
  },
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
});

// quick auth sanity check before doing anything else:
try {
  const r = await provider.get('/api/offers');
  console.log('Auth OK, offers:', r.data?._embedded?.offers?.length ?? 0);
} catch (e) {
  console.error('Auth failed:', e.response?.status, e.response?.headers?.['www-authenticate'], e.response?.data);
  process.exit(1);
}
