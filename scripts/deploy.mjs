// dist/를 빌드해서 gh-pages 브랜치에 강제 push한다 → GitHub Pages가 그 브랜치를 배포한다.
import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });
const remote = execSync('git remote get-url origin').toString().trim();
const rev = execSync('git rev-parse --short HEAD').toString().trim();

sh('npm run build');
const dir = mkdtempSync(join(tmpdir(), 'pixel-subject-'));
cpSync('dist', dir, { recursive: true });
writeFileSync(join(dir, '.nojekyll'), '');
sh('git init -q -b gh-pages', dir);
sh('git add -A', dir);
sh(`git commit -q -m "Deploy ${rev}"`, dir);
sh(`git push -f ${remote} gh-pages`, dir);
rmSync(dir, { recursive: true, force: true });
