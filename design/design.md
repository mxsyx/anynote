1. 支持富文本编辑与Markdown编辑。

2. 支持链接收藏(着重优化这方面的功能)

3. 支持私有云部署但不支持云协作



编译安装sqlite3
>cnpm install -g node-gyp

>cnpm install -g windows-build-tools

>node-gyp rebuild --target=8.2.0 --arch=x64 --target_platform=win32 --dist-url=https://atom.io/download/electron/ --module_name=node_sqlite3 --module_path=../lib/binding/electron-v8.2.0-win32-x64
