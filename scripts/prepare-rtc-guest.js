// Run on the development machine, after building ../homegames-client.
// The output is a tiny static nginx site; no Node/website deployment is needed.
const fs = require('fs');
const os = require('os');
const path = require('path');

const output = process.argv[2] ? path.resolve(process.argv[2])
    : fs.mkdtempSync(path.join(os.tmpdir(), 'homegames-rtc-guest-'));
const bundle = path.resolve(__dirname, '../../homegames-client/dist/homegames-client.js');
if (!fs.existsSync(bundle)) throw new Error('Build homegames-client first: npm --prefix ../homegames-client run build');
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.resolve(__dirname, '../deploy/rtc-guest.html'), path.join(output, 'index.html'));
fs.copyFileSync(bundle, path.join(output, 'homegames-client.js'));
if (fs.existsSync(`${bundle}.LICENSE.txt`)) {
    fs.copyFileSync(`${bundle}.LICENSE.txt`, path.join(output, 'homegames-client.js.LICENSE.txt'));
}
console.log(`Guest page prepared at ${output}`);
