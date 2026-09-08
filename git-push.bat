@echo off
set PATH=D:\software\Git\cmd;%PATH%
cd /d D:\workspace\forge

echo === Git add all files ===
git add .
if errorlevel 1 (
    echo git add failed
    exit /b 1
)

echo === Git commit ===
git commit -m "Initial commit: Forge - AI frontend development agent

- 6 agents: Requirement, Design, Review, Coding, Delivery
- Harness orchestration with 15-state state machine
- Knowledge base with vector search and AST parsing
- TDD-driven coding with per-story loop
- Multi-round design review and code review
- Delivery with file write, git operations, build verification
- 315 tests passing"
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
