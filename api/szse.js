const http = require('http');

module.exports = function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    
    const pageSize = (req.query && req.query.pageSize) || '30';
    
    return new Promise((resolve) => {
        const opts = {
            hostname: 'reits.szse.cn', port: 80,
            path: '/api/disc/info/find/tannInfo?type=4&pageSize='+pageSize+'&pageNum=1',
            method: 'GET',
            headers: { 'Referer': 'http://reits.szse.cn/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
            timeout: 15000
        };
        
        const hReq = http.request(opts, (hRes) => {
            let body = '';
            hRes.on('data', c => body += c);
            hRes.on('end', () => {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.status(200).send(body);
                resolve();
            });
        });
        hReq.on('error', (e) => { 
            res.status(500).json({error: 'SZSE unreachable: '+e.message}); 
            resolve(); 
        });
        hReq.on('timeout', () => { 
            hReq.destroy(); 
            res.status(504).json({error: 'SZSE timeout'}); 
            resolve(); 
        });
        hReq.end();
    });
};
