import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = path.join(ROOT, 'certs');

function localAddresses() {
  const addresses = new Set(['127.0.0.1', '::1']);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal) continue;
      if (entry.family === 'IPv4' || entry.family === 'IPv6') addresses.add(entry.address);
    }
  }
  return [...addresses];
}

const addresses = localAddresses();
const altNames = [
  { type: 2, value: 'localhost' },
  { type: 2, value: os.hostname() },
  ...addresses.map((address) => ({ type: 7, ip: address })),
];

console.log('正在为以下地址生成自签名证书：');
console.log('  localhost');
console.log('  ' + os.hostname());
for (const address of addresses) console.log('  ' + address);

const pems = selfsigned.generate(
  [{ name: 'commonName', value: 'SoundBridge Local' }],
  {
    keySize: 2048,
    days: 365,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  },
);

await mkdir(CERT_DIR, { recursive: true });
await writeFile(path.join(CERT_DIR, 'cert.pem'), pems.cert, 'utf8');
await writeFile(path.join(CERT_DIR, 'key.pem'), pems.private, 'utf8');

console.log('');
console.log('证书已生成：certs/cert.pem 与 certs/key.pem');
console.log('重启服务后即可使用 HTTPS。浏览器首次打开会提示证书不受信任，');
console.log('确认继续访问后，系统声音采集权限才会生效。');
