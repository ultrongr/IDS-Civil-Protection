// crypto-enc.js
const crypto = require('crypto');
const KEY = crypto.scryptSync(process.env.DB_KEY || 'change-me', 'dataspace-api-static-salt', 32);
function enc(str) {
  if (str == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(str), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}
function dec(b64) {
  if (!b64) return null;
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.slice(0,12), tag = buf.slice(12,28), ct = buf.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
module.exports = { enc, dec };
