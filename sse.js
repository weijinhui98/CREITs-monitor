const https = require('https');
const querystring = require('querystring');

module.exports = function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const pageSize = req.query?.pageSize || '30';
    const postData = querystring.stringify({
        sqlId: 'REITS_BULLETIN', isPagination: 'true',
        fundCode: '', startDate: '', endDate: '',
        'pageHelp.pageSize': pageSize, 'pageHelp.cacheSize': '1',
        'pageHelp.pageNo': '1', 'pageHelp.beginPage': '1', 'pageHelp.endPage': '1'
    });

    return new Promise((resolve) => {
        const hReq = https.request({
            hostname: 'query.sse.com.cn', port: 443, path: '/commonSoaQuery.do', method: 'POST',
            headers: { 'Referer': 'https://www.sse.com.cn/', 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
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
        hReq.write(postData); hReq.end();
    });
};
