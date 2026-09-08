@echo off
set PATH=D:\software\Git\cmd;%PATH%
cd /d D:\workspace\forge

echo === Reset staging area ===
git reset

echo === Git add all files ===
git add --all
if errorlevel 1 (
    echo git add failed
    exit /b 1
)

echo === Git commit ===
git commit -m "Initial commit: Forge - AI frontend development agent with 6 agents, harness orchestration, knowledge base, TDD coding, and delivery pipeline"
if errorlevel 1 (
    echo git commit failed
    exit /b 1
)

echo === Git push ===
git push -u origin main
if errorlevel 1 (
    echo git push failed
    exit /b 1
)

echo === Done ===
git log --oneline -1
