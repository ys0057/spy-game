@echo off
cd /d "c:\Users\user\Desktop\workspace\spy-game"
git config user.name "ys0057"
git config user.email "ys0057@users.noreply.github.com"
git add .
git commit -m "feat: spy game complete (84 word pairs)"
git branch -M main
git remote remove origin 2>nul
git remote add origin https://github.com/ys0057/spy-game.git
git push -u origin main
pause
