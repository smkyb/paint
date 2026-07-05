import http from 'http';

const port = 3000;
const host = '0.0.0.0';

const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('アクセス成功です！');
});

server.listen(port, host, () => {
    console.log(`サーバー起動中: ポート ${port} で待機しています。`);
});