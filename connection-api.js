'use strict';
const { budget, clientIp: readIp } = require('homegames-common/network-limits');
const clientIp = (req, trustProxy = false) => readIp(req, trustProxy, 'x-forwarded-for');
function createHandler({ service, trustProxy = false, now = Date.now, bodyTimeoutMs = 5000,
    maxCertificateOperations = 32, maxCertificateOperationsPerIp = 4 } = {}) {
    const limits = new Map();
    const admitStatus = budget({ limit: 120, now }), admitGlobal = budget({ limit: 600, maxKeys: 1, now });
    const active = new Map(); let pending = 0;
    const reply = (res, status, value) => {
        const body = JSON.stringify(value);
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store', ...(status === 429 ? { 'Retry-After':'60' } : {})});
        res.end(body);
    };
    return async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin','*');
        res.setHeader('Access-Control-Allow-Headers','Content-Type');
        res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
        if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
        let operationIp;
        try {
            const url = new URL(req.url,'http://localhost'), ip = clientIp(req,trustProxy);
            if (url.pathname === '/cert-status' || url.pathname === '/request-cert') {
                if (!ip || pending >= maxCertificateOperations || (active.get(ip) || 0) >= maxCertificateOperationsPerIp
                    || !admitStatus(ip) || !admitGlobal('all')) return reply(res,429,{error:'Too many certificate operations'});
                operationIp = ip; pending++; active.set(ip, (active.get(ip) || 0) + 1);
            }
            if(req.method==='GET'&&url.pathname==='/health')return reply(res,200,{ok:true,...(service.health?{certificates:service.health()}:{})});
            if(req.method==='GET'&&url.pathname==='/ip'){res.writeHead(200,{'Content-Type':'text/plain'});res.end(ip);return;}
            if(req.method==='GET'&&url.pathname==='/cert-status')return reply(res,200,await service.status(ip,url.searchParams.get('requestId')));
            if(req.method==='POST'&&url.pathname==='/verifyDns'){res.end('ok');return;}
            if(req.method==='POST'&&url.pathname==='/request-cert') {
                for(const [key,value] of limits)if(value.until<=now())limits.delete(key);
                const limit=limits.get(ip)||{count:0,until:now()+3600000};
                if(++limit.count>10||(!limits.has(ip)&&limits.size>=10000))return reply(res,429,{error:'Too many certificate requests'});
                limits.set(ip,limit);
                let length=0,body='';
                const deadline = setTimeout(() => req.destroy(Object.assign(new Error('Request body timed out'), {statusCode:408})), bodyTimeoutMs);
                try { for await(const chunk of req){length+=Buffer.byteLength(chunk);if(length>40000)return reply(res,413,{error:'Request too large'});body+=chunk;} }
                finally { clearTimeout(deadline); }
                const {csr,requestId}=JSON.parse(body);
                return reply(res,200,await service.request(ip,csr,requestId));
            }
            reply(res,404,{error:'Not found'});
        } catch(error) {
            const status = error.statusCode || (error instanceof SyntaxError || error instanceof TypeError ? 400 : 503);
            reply(res,status,{error:status>=500?'Certificate service temporarily unavailable':error.message});
        } finally {
            if (operationIp) { pending--; const count = active.get(operationIp) - 1; if (count) active.set(operationIp,count); else active.delete(operationIp); }
        }
    };
}
module.exports = { createHandler, clientIp };
