@echo off
cd /d "C:\Users\99687\Desktop\DSH插件发布"
set "NODE=C:\Users\99687\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
"%NODE%" ".workbuddy\tools\npm_watch.cjs" >> ".workbuddy\npm_watch.log" 2>&1
