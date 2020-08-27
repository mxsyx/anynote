# Anynote
A private note solution


## Feature

1. Support rich text editing and Markdown editing.

2. Customizable tabel of contents with Gmail style.



## For Developer

### On Linux or MacOS

npm install

npm install -g node-gyp

npm install sqlite3 --build-from-source --runtime=electron --target=9.1.0 --dist-url=https://atom.io/download/electron

### On Windows

npm install

npm install -g node-gyp

npm install --global --production windows-build-tools (On Windows)

npm install sqlite3 --build-from-source --runtime=electron --target=9.1.0 --dist-url=https://atom.io/download/electron


## 指导思想

技术上借鉴蚂蚁笔记 
界面上借鉴语雀
功能上借鉴有道云笔记 

Antnote 是一个笔记本平台，侧重于记录本地笔记，它只提供核心功能，通过插件可扩展其功能。它没有中央服务器与云的概念，因此不适合做链接分享、实时协同类操作。

