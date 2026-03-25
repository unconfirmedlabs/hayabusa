import { copyFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const sonaDir = join(homedir(), 'Documents/sona/hayabusa');
const src = join(sonaDir, 'config.json');
const dest = join(import.meta.dir, '..', 'src', 'config.json');

copyFileSync(src, dest);
console.log(`Copied config.json → src/config.json`);
