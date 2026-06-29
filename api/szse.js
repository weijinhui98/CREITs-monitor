const https = require('https');

module.exports = function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    const pageSize = (req.query && req.query.pageSize) || '30';
    
    return new Promise((resolve) => {
        const hReq = https.request({
            hostname: 'reits.szse.cn', port: 443,
            path: '/api/disc/info/find/tannInfo?type=4&pageSize='+pageSize+'&pageNum=1',
            method: 'GET',
            headers: { 'Referer': 'https://reits.szse.cn/', 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        }, (hRes) => {
            let body = '';
            hRes.on('data', c => body += c);
            hRes.on('end', () => {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.status(200).send(body);
                resolve();
            });
        });
        hReq.on('error', (e) => { res.status(500).json({error:e.message}); resolve(); });
        hReq.end();
    });
};
