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

(async () => {
	const browser = await puppeteer.launch({
		headless: false,
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

	page.setDefaultTimeout(0)
	await page.goto('https://kyfw.12306.cn/otn/resources/login.html');
	await page.type('#J-userName', user)
	await page.type('#J-password', pass)
	await page.click('#J-login');
	await page.type('#id_card', id);
	await page.click('#verification_code');
    await page.focus('#code');
	await page.waitForFunction(() => {
		const captcha = document.querySelector('#code').value;
		return captcha.length >= 6;
	});
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => null),
		page.click('#sureClick')
	]);
	// await page.waitForSelector('#link_for_ticket');
	// await page.click('#link_for_ticket');
	// await page.waitForSelector('#query_ticket');
    await page.goto('https://kyfw.12306.cn/otn/leftTicket/init');
	await page.evaluate((fromstation, tostation, time) => {
		document.querySelector('#fromStation').value = fromstation;
		document.querySelector('#toStation').value = tostation;
		document.querySelector('#train_date').value = time;
	}, fromstation, tostation, time)

    let found = 0;

    while (found == 0){
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
                                    }else{
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
            let needRelogin = 0;
            try {
                // const style = document.querySelector('.login-account').computedStyleMap();
                // const style2 = document.querySelector('#J-userName').computedStyleMap();
                // await page.waitForSelector('#J-userName', { timeout: 1000 });
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
            if (!needRelogin) {
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
                    try {
                        await page.type('#id_card', id);
                        await page.click('#verification_code');
                        await page.focus('#code');
                        await page.waitForFunction(() => {
                            const el = document.querySelector('#code');
                            return el && el.value && el.value.length >= 6;
                        }, { timeout: 120000 });
                        await page.click('#sureClick');
                    } catch {}
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
        }
    }
    console.log('found：', found);
    if (found == 0) {
        console.log('没有找到列车');
        return;
    }
    // 会话过期处理：如果未进入确认乘客页，自动登录并重新查票预订
    while (true) {
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
                await page.waitForSelector('#qr_submit_id', { timeout: 5000 });
                await page.click('#qr_submit_id');
            } else if (found == 2) {
                await page.waitForSelector('#passenge_list', { timeout: 15000 });
                // 勾选匹配姓名列表的乘客
                await safe$$eval(page, '#passenge_list label', (labels, names) => {
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
                        }
                    }
                }, passengerNames);
                await page.click('#toPayBtn');
                await page.waitForSelector('.btn.btn-primary.ok', { timeout: 5000 });
                await page.click('.btn.btn-primary.ok');
            }
        } catch (e) {
            let needRelogin = 0;
            try {
                // const style = document.querySelector('.login-account').computedStyleMap();
                // const style2 = document.querySelector('#J-userName').computedStyleMap();
                // await page.waitForSelector('#J-userName', { timeout: 1000 });
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
            if (!needRelogin) {
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
                    try {
                        await page.type('#id_card', id);
                        await page.click('#verification_code');
                        await page.focus('#code');
                        await page.waitForFunction(() => {
                            const el = document.querySelector('#code');
                            return el && el.value && el.value.length >= 6;
                        }, { timeout: 120000 });
                        await page.click('#sureClick');
                    } catch {}
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
                    // 再次查票并点击预订/候补
                    let foundAgain = 0;
                    while (foundAgain == 0) {
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
                        const matchedAgain = await safe$$eval(page, '#queryLeftTable tr', async (trs, bookOrder, bookCount) => {
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
                                                }else{
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
                        foundAgain = matchedAgain;
                        if (foundAgain == 1) {
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
                            await page.waitForSelector('#qr_submit_id', { timeout: 5000 });
                            await page.click('#qr_submit_id');
                        } else if (foundAgain == 2) {
                            await page.waitForSelector('#passenge_list', { timeout: 10000 });
                            // 勾选匹配姓名列表的乘客
                            await safe$$eval(page, '#passenge_list label', (labels, names) => {
                                for (const label of labels) {
                                    const title = (label.getAttribute('title') || '').trim();
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
                                    }
                                }
                            }, passengerNames);
                            await page.click('#toPayBtn');
                            await page.waitForSelector('.btn.btn-primary.ok', { timeout: 10000 });
                            await page.click('.btn.btn-primary.ok');
                        }
                    }
                } catch(e) {
                    console.log(e);
                }
            }else{
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
                    page.reload({ waitUntil: 'domcontentloaded' })
                ]);
                continue;
            }
        }
        break;
    }
})()
