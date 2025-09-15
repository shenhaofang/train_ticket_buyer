import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const user = config.user; 
const pass = config.pass; 
const id = config.id; 
const passengerNames = config.passengerNames; // 要勾选的乘客姓名列表
const fromstation = config.fromstation; // 出发地
const tostation = config.tostation; // 目的地
const time = config.time; // 出发日期  格式 YYYY-MM-DD
const chromeExecutablePath = config.chromeExecutablePath || '';
const chromeChannel = config.chromeChannel || '';
const ticket2Buy = config.ticket2Buy || []; 
const headless = config.headless || false;

const seatMap = {
    '商务座': '1',
    '优选一等座': '2',
    '一等座': '3',
    '二等座': '4',
    '高级软卧': '5',
    '软卧': '6',
    '硬卧': '7',
    '软座': '8',
    '硬座': '9',
    '无座': '10',
};

if (ticket2Buy.length == 0) {
    console.log('请在 config.json 中配置 ticket2Buy 字段，指定要购买的席别优先级');
    process.exit(1);
}

let codeFilePath = path.join(__dirname, 'captcha.txt');
if (headless) {
    if (!fs.existsSync(codeFilePath)) {
        console.log('请在无头模式下运行前，先创建 captcha.txt 文件，用于输入验证码');
        process.exit(1);
    }
    // 清空验证码文件内容
    fs.writeFileSync(codeFilePath, '', 'utf8');
} else {
    codeFilePath = '';
}

let bookOrder = {};
//   "ticket2Buy": [
//     {
//       "trainNum": "Z196",
//       "sort": 1,
//       "seatType": "硬卧"
//     },
//     {
//       "trainNum": "Z268",
//       "sort": 2,
//       "seatType": "硬卧"
//     }
//   ]
ticket2Buy.forEach(item => {
    if (item.trainNum && item.sort && item.seatType && seatMap[item.seatType]) {
        if (!bookOrder[item.trainNum]) {
            bookOrder[item.trainNum] = {
                [seatMap[item.seatType]]: {
                    'sort': item.sort,
                    'seatType': item.seatType
                }
            };
        }
        bookOrder[item.trainNum][seatMap[item.seatType]] = {
            'sort': item.sort,
            'seatType': item.seatType
        };
    }else{
        console.log('ticket2Buy 配置错误，请检查 trainNum, sort, seatType 字段及 seatType 的值是否正确', item, seatMap[item.seatType]);
    }
});

console.log('bookOrder:', bookOrder);
// process.exit(0);

function isNavigationContextError(error) {
    const message = (error && (error.message || String(error))) || '';
    return message.includes('Execution context was destroyed') || message.includes('Cannot find context') || message.includes('Target closed');
}

async function safe$$eval(page, selector, pageFunction, ...args) {
    for (let attempt = 0; attempt < 1; attempt++) {
        try {
            await page.waitForSelector(selector, { timeout: 10000 });
            return await page.$$eval(selector, pageFunction, ...args);
        } catch (error) {
            if (isNavigationContextError(error)) {
                await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 }).catch(() => {});
                await new Promise(resolve => setTimeout(resolve, 300));
                continue;
            }
            throw error;
        }
    }
    throw new Error(`safe$$eval: retries exceeded for selector ${selector}`);
}

async function checkReLogin(page, codeFilePath = '') {
    let needRelogin = 0;
    try {
        const loginAccount = await page.$('.login-account');
        if (loginAccount) {
            const display = await loginAccount.evaluate(el => getComputedStyle(el).display);
            if (display !== 'none') {
                needRelogin = 1;
            }
        }
    } catch(e) {
        console.log(e);
    }
    if (needRelogin == 0) {
        try {
            const currentUrl = page.url();
            if (currentUrl.includes('login')) needRelogin = 2;
        } catch {}
    }

    if (needRelogin > 0) {
        try {
            await page.type('#J-userName', user);
            await page.type('#J-password', pass);
            await page.click('#J-login');
            // 某些情况下需要再次填写身份证及验证码
            await page.type('#id_card', id);
            if (codeFilePath) {
                for (let i = 0; i < 10; i++) {
                    let code = '';
                    // 清空验证码文件内容，等待重新输入
                    fs.writeFileSync(codeFilePath, '', 'utf8');
                    if (i%2 == 0) {
                        await page.click('#verification_code');
                    }
                    await page.focus('#code');
                    while (code.length < 6) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        code = fs.readFileSync(codeFilePath, 'utf8').trim();
                    }
                    await page.type('#code', code);
                    await page.click('#sureClick');
                    // 验证码填写正确
                    try {
                        await page.waitForResponse(async res => {
                            console.log('[RESPONSE1]', res.url(), res.status());
                            if (!res.url().includes('passport/web/login') || res.status() !== 200) {
                                return false;
                            }
                            if (res.url().includes('login/userLogin')){
                                return true;
                            }
                            // 检查是否为预检请求
                            const request = res.request();
                            if (request.method() === 'OPTIONS') {
                                return false;
                            }

                            const josnBody = (await res.json());
                            console.log('[RESPONSE2]', res.url(), res.status(), josnBody);
                            return josnBody.result_code == 0;
                        }, { timeout: 5000 });
                    }catch (e) {
                        console.log(e);
                        const message = (e && (e.message || String(e))) || '';
                        if (message.includes('Timed out')) {
                            // 清空已填写的验证码，重新填写
                            await page.evaluate(() => { const el = document.querySelector('#code'); if (el) el.value = ''; });
                            continue;
                        }
                    }
                    break;
                }
            }else{
                for (let i = 0; i < 10; i++) {
                    if (i%2 == 0) {
                        await page.click('#verification_code');
                    }
                    await page.focus('#code');
                    await page.waitForFunction(() => {
                        const el = document.querySelector('#code');
                        return el && el.value && el.value.length >= 6;
                    }, { timeout: 120000 });
                    await page.click('#sureClick');
                    // 验证码填写正确
                    try {
                        await page.waitForResponse(async res => {
                            console.log('[RESPONSE1]', res.url(), res.status());
                            if (!res.url().includes('passport/web/login') || res.status() !== 200) {
                                return false;
                            }
                            if (res.url().includes('login/userLogin')){
                                return true;
                            }
                            // 检查是否为预检请求
                            const request = res.request();
                            if (request.method() === 'OPTIONS') {
                                return false;
                            }

                            const josnBody = (await res.json());
                            console.log('[RESPONSE2]', res.url(), res.status(), josnBody);
                            return josnBody.result_code == 0;
                        }, { timeout: 5000 });
                    }catch (e) {
                        console.log(e);
                        const message = (e && (e.message || String(e))) || '';
                        if (message.includes('Timed out')) {
                            // 清空已填写的验证码，重新填写
                            await page.evaluate(() => { const el = document.querySelector('#code'); if (el) el.value = ''; });
                            continue;
                        }
                    }
                    break;
                }
            }
            if (needRelogin == 2){
                // 跳回查票页
                try {
                    await page.goto('https://kyfw.12306.cn/otn/leftTicket/init');
                } catch {}
            }
            // 重新填写查询条件
            await page.waitForSelector('#query_ticket');
            await page.evaluate((fromstation, tostation, time) => {
                document.querySelector('#fromStation').value = fromstation;
                document.querySelector('#toStation').value = tostation;
                document.querySelector('#train_date').value = time;
            }, fromstation, tostation, time);
        }catch (e) {
            console.log(e);
        }
    }
    return needRelogin;
}

(async () => {
	const browser = await puppeteer.launch({
		headless: headless,
		slowMo: 20,
		...(chromeChannel ? { channel: chromeChannel } : {}),
		...(chromeExecutablePath && !chromeChannel ? { executablePath: chromeExecutablePath } : {}),
	});
	const page = await browser.newPage();
    page.on('console', msg => { try { console.log('[PAGE]', msg.type(), msg.text()); } catch {} });
    page.on('pageerror', err => console.error('[PAGEERROR]', err));
    page.on('error', err => console.error('[PAGE-ERR]', err));
    page.on('framenavigated', f => console.log('[NAV]', f.url()));
    page.on('requestfailed', req => console.warn('[REQ-FAIL]', req.url(), req.failure()?.errorText));
    browser.on('disconnected', () => console.error('[BROWSER] disconnected'));
    process.on('unhandledRejection', e => console.error('[UNHANDLED REJECTION]', e));
    process.on('uncaughtException', e => console.error('[UNCAUGHT EXCEPTION]', e));
    page.setViewport({
        width: 1920,
        height: 1080,
        deviceScaleFactor: 1,
    })
	page.setDefaultTimeout(0)
	await page.goto('https://kyfw.12306.cn/otn/resources/login.html');
	await page.type('#J-userName', user)
	await page.type('#J-password', pass)
	await page.click('#J-login');
	await page.type('#id_card', id);
    if (codeFilePath) {
        for (let i = 0; i < 10; i++) {
            let code = '';
            // 清空验证码文件内容，等待重新输入
            fs.writeFileSync(codeFilePath, '', 'utf8');
            if (i%2 == 0) {
                await page.click('#verification_code');
            }
            await page.focus('#code');
            while (code.length < 6) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                code = fs.readFileSync(codeFilePath, 'utf8').trim();
            }
            await page.type('#code', code);
            await page.click('#sureClick');
            // 验证码填写正确
            try {
                await page.waitForResponse(async res => {
                    console.log('[RESPONSE1]', res.url(), res.status());
                    if (!res.url().includes('passport/web/login') || res.status() !== 200) {
                        return false;
                    }
                    if (res.url().includes('login/userLogin')){
                        return true;
                    }
                    // 检查是否为预检请求
                    const request = res.request();
                    if (request.method() === 'OPTIONS') {
                        return false;
                    }

                    const josnBody = (await res.json());
                    console.log('[RESPONSE2]', res.url(), res.status(), josnBody);
                    return josnBody.result_code == 0;
                }, { timeout: 5000 });
            }catch (e) {
                console.log(e);
                const message = (e && (e.message || String(e))) || '';
                if (message.includes('Timed out')) {
                    // 清空已填写的验证码，重新填写
                    await page.evaluate(() => { const el = document.querySelector('#code'); if (el) el.value = ''; });
                    continue;
                }
            }
            break;
        }
    }else{
        for (let i = 0; i < 10; i++) {
            if (i%2 == 0) {
                await page.click('#verification_code');
            }
            await page.focus('#code');
            await page.waitForFunction(() => {
                const captcha = document.querySelector('#code').value;
                return captcha.length >= 6;
            });
            page.click('#sureClick')
            // 验证码填写正确
            try {
                await page.waitForResponse(async res => {
                    console.log('[RESPONSE1]', res.url(), res.status());
                    if (!res.url().includes('passport/web/login') || res.status() !== 200) {
                        return false;
                    }
                    if (res.url().includes('login/userLogin')){
                        return true;
                    }
                    // 检查是否为预检请求
                    const request = res.request();
                    if (request.method() === 'OPTIONS') {
                        return false;
                    }

                    const josnBody = (await res.json());
                    console.log('[RESPONSE2]', res.url(), res.status(), josnBody);
                    return josnBody.result_code == 0;
                }, { timeout: 3000 });
            }catch (e) {
                console.log(e);
                const message = (e && (e.message || String(e))) || '';
                if (message.includes('Timed out')) {
                    // 清空已填写的验证码，重新填写
                    await page.evaluate(() => { const el = document.querySelector('#code'); if (el) el.value = ''; });
                    continue;
                }
            }
            break;
        }
    }
	// await page.waitForSelector('#link_for_ticket');
	// await page.click('#link_for_ticket');
	// await page.waitForSelector('#query_ticket');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => null);
    await page.goto('https://kyfw.12306.cn/otn/leftTicket/init');
    await page.waitForSelector('#query_ticket');
	await page.evaluate((fromstation, tostation, time) => {
		document.querySelector('#fromStation').value = fromstation;
		document.querySelector('#toStation').value = tostation;
		document.querySelector('#train_date').value = time;
	}, fromstation, tostation, time)

    let found = 0;

    while (true){
        if (found == 0){
            try {
                await page.click('#query_ticket');
                await Promise.race([
                    page.waitForResponse(res => res.url().includes('leftTicket/queryG') && res.status() === 200, { timeout: 10000 }).catch(() => null),
                    new Promise(resolve => setTimeout(resolve, 2000))
                ]);
                try{
                    await page.waitForSelector('#queryLeftTable tr', { timeout: 1000 });
                }catch(e){
                    continue;
                }
                
                const matched = await safe$$eval(page, '#queryLeftTable tr', async (trs, bookOrder, bookCount) => {
                    let firstTr = null;
                    let currentTrOrder = 999;
                    let firstBakTr = null; 
                    let currentBakTrOrder = 999;
                    let bakSeatIdx = 0;
                    for (let i = 0; i < trs.length; i++) {
                        let tr = trs[i];
                        if (tr.childElementCount == 13) {
                            console.log(tr.children[0].children[0].children[0].children[0].children[0].innerText);
                            const trainCfg = bookOrder[tr.children[0].children[0].children[0].children[0].children[0].innerText];
                            if (trainCfg) {
                                for (const seat in trainCfg) {
                                    console.log(trainCfg[seat].seatType, tr.children[seat].innerText);
                                    if (tr.children[seat].innerText != '--') {
                                        // if (tr.children[seat].innerText != '候补') {
                                        if (tr.children[seat].innerText == '有' || tr.children[seat].innerText.trim() >= bookCount) {
                                            if (currentTrOrder > trainCfg[seat].sort) {
                                                firstTr = tr;
                                                currentTrOrder = trainCfg[seat].sort;
                                            }
                                            break;
                                        }else if (tr.children[seat].innerText == '候补') {
                                            if (currentBakTrOrder > trainCfg[seat].sort) {
                                                firstBakTr = tr;
                                                currentBakTrOrder = trainCfg[seat].sort;
                                                bakSeatIdx = seat;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if (firstTr) {
                        firstTr.lastChild.firstChild.click();
                        return 1;
                    }
                    if (firstBakTr) {
                        firstBakTr.children[bakSeatIdx].click();
                        return 2;
                    }
                    return 0;
                }, bookOrder, passengerNames.length);
                found = matched;
            }catch (e) {
                console.log(e);
                const relogined = await checkReLogin(page, codeFilePath)
                // 只有自动跳转会登录页的情况下，才继续循环，否则登录后会直接进入乘客确认页
                if (relogined == 2) {
                    continue;
                }
            }
            console.log('found：', found);
            if (found == 0) {
                await page.goto('https://kyfw.12306.cn/otn/leftTicket/init');
                // 重新填写查询条件
                await page.waitForSelector('#query_ticket');
                await page.evaluate((fromstation, tostation, time) => {
                    document.querySelector('#fromStation').value = fromstation;
                    document.querySelector('#toStation').value = tostation;
                    document.querySelector('#train_date').value = time;
                }, fromstation, tostation, time);
                continue;
            }
        }
        // 会话过期处理：如果未进入确认乘客页，自动登录并重新查票预订
        try {
            if (found == 1) {
                await page.waitForSelector('#normal_passenger_id', { timeout: 15000 });
                // 勾选匹配姓名列表的乘客（normal 列表用 label for=... 关联 input）
                const clicked = await safe$$eval(page, '#normal_passenger_id label', (labels, names) => {
                    let count = 0;
                    for (const label of labels) {
                        const title = (label.textContent || '').trim();
                        if (!names.some(n => title.includes(n))) continue;
                        const forId = label.getAttribute('for');
                        const input = forId ? document.getElementById(forId) : null;
                        if (!input) continue;
                        if (!input.checked) {
                            label.scrollIntoView({ block: 'center' });
                            label.click();
                            count++;
                        }
                    }
                    return count;
                }, passengerNames);
                console.log('normal clicked:', clicked);
                await page.click('#submitOrder_id');
                console.log('submitOrder_id clicked');
                await page.waitForSelector('#qr_submit_id', { timeout: 5000 });
                await page.click('#qr_submit_id');
                console.log('qr_submit_id clicked');
            } else if (found == 2) {
                await page.waitForSelector('#passenge_list', { timeout: 15000 });
                // 勾选匹配姓名列表的乘客
                const clicked = await safe$$eval(page, '#passenge_list label', (labels, names) => {
                    let count = 0;
                    for (const label of labels) {
                        const title = (label.getAttribute('title') || '').trim();
                        console.log(title);
                        if (!names.some(n => title.includes(n))) continue;

                        console.log(title);
                        
                        const input = label.querySelector('input.chose-pass-dom');
                        if (!input) continue;

                        const box = label.querySelector('.icheckbox');
                        const helper = label.querySelector('.iCheck-helper');
                        const alreadyChecked = (box && box.classList.contains('checked')) || (input && input.checked);

                        if (!alreadyChecked) {
                            const target = helper || box || label;
                            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                            count++;
                        }
                    }
                }, passengerNames);
                console.log('passenge clicked:', clicked);
                await page.click('#toPayBtn');
                console.log('toPayBtn clicked');
                await page.waitForSelector('.btn.btn-primary.ok', { timeout: 5000 });
                await page.click('.btn.btn-primary.ok');
                console.log('btn-primary.ok clicked');
            }
        } catch (e) {
            console.log(e);
            try{
                await page.waitForSelector('#ERROR', { timeout: 3000 });
                found = 0;
                await page.goto('https://kyfw.12306.cn/otn/leftTicket/init');
                // 重新填写查询条件
                await page.waitForSelector('#query_ticket');
                await page.evaluate((fromstation, tostation, time) => {
                    document.querySelector('#fromStation').value = fromstation;
                    document.querySelector('#toStation').value = tostation;
                    document.querySelector('#train_date').value = time;
                }, fromstation, tostation, time);
                continue;
            }catch{
                const relogined = await checkReLogin(page, codeFilePath)
                if (relogined == 2) {
                    found = 0;
                    continue;
                }
                if (relogined == 1) {
                    continue;
                }
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => null),
                    page.reload({ waitUntil: 'domcontentloaded' })
                ]);
                continue;
            }
        }
        break;
    }
})()
