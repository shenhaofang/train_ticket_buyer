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

function isNavigationContextError(error) {
    const message = (error && (error.message || String(error))) || '';
    return message.includes('Execution context was destroyed') || message.includes('Cannot find context') || message.includes('Target closed');
}

async function safe$$eval(page, selector, pageFunction, ...args) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await page.waitForSelector(selector, { timeout: 15000 });
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
		slowMo: 50,
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
        await page.click('#query_ticket');
        await Promise.race([
            page.waitForResponse(res => res.url().includes('leftTicket/queryG') && res.status() === 200, { timeout: 10000 }).catch(() => null),
            new Promise(resolve => setTimeout(resolve, 2000))
        ]);
        await page.waitForSelector('#queryLeftTable', { timeout: 10000 }).catch(() => {});
        const matched = await safe$$eval(page, '#queryLeftTable tr', async trs => {
			let bookOrder = {
				'Z196': 1,
				'Z268': 2,
			};
			let firstTr = null;
			let currentTrOrder = 999;
			let firstBakTr = null; 
			let currentBakTrOrder = 999;
            for (let i = 0; i < trs.length; i++) {
                let tr = trs[i];
                if (tr.childElementCount == 13) {
					console.log(tr.children[0].children[0].children[0].children[0].children[0].innerText);
					if (bookOrder[tr.children[0].children[0].children[0].children[0].children[0].innerText]) {
						console.log(tr.children[7].innerText);
						if (tr.children[7].innerText != '--') {
							if (tr.children[7].innerText != '候补') {
								if (currentTrOrder > bookOrder[tr.children[0].children[0].children[0].children[0].children[0].innerText]) {
									firstTr = tr;
									currentTrOrder = bookOrder[tr.children[0].children[0].children[0].children[0].children[0].innerText];
								}
							}else{
								if (currentBakTrOrder > bookOrder[tr.children[0].children[0].children[0].children[0].children[0].innerText]) {
									firstBakTr = tr;
									currentBakTrOrder = bookOrder[tr.children[0].children[0].children[0].children[0].children[0].innerText];
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
				firstBakTr.children[7].click();
				return 2;
			}
			return 0;
        });
        found = matched;
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
                const clicked = await page.$$eval('#normal_passenger_id label', (labels, names) => {
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
                await page.$$eval('#passenge_list label', (labels, names) => {
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
                await page.waitForSelector('.btn.btn-primary.ok', { timeout: 5000 });
                await page.click('.btn.btn-primary.ok');
            }
        } catch (e) {
            let needRelogin = false;
            try {
                await page.waitForSelector('#J-userName', { timeout: 2000 });
                needRelogin = true;
            } catch {}
            if (!needRelogin) {
                try {
                    const currentUrl = page.url();
                    if (currentUrl.includes('login')) needRelogin = true;
                } catch {}
            }

            if (needRelogin) {
                try {
                    await page.type('#J-userName', user);
                    await page.type('#J-password', pass);
                    await page.click('#J-login');
                    // 某些情况下需要再次填写身份证及验证码
                    try {
                        await page.type('#id_card', id);
                        await page.click('#verification_code');
                        await page.waitForFunction(() => {
                            const el = document.querySelector('#code');
                            return el && el.value && el.value.length >= 6;
                        }, { timeout: 120000 });
                        await page.click('#sureClick');
                    } catch {}
                    // 跳回查票页
                    try {
                        await page.goto('https://kyfw.12306.cn/otn/leftTicket/init');
                    } catch {}
                    // 重新填写查询条件
                    try {
                        await page.waitForSelector('#query_ticket');
                        await page.evaluate((fromstation, tostation, time) => {
                            document.querySelector('#fromStation').value = fromstation;
                            document.querySelector('#toStation').value = tostation;
                            document.querySelector('#train_date').value = time;
                        }, fromstation, tostation, time);
                    } catch {}
                    // 再次查票并点击预订/候补
                    let foundAgain = 0;
                    while (foundAgain == 0) {
                        await page.click('#query_ticket');
                        const matchedAgain = await page.$$eval('tr', async trs => {
                            let bookOrder = {
                                'Z196': 1,
                                'Z268': 2,
                            };
                            let firstTr = null;
                            let currentTrOrder = 999;
                            let firstBakTr = null;
                            let currentBakTrOrder = 999;
                            for (let i = 0; i < trs.length; i++) {
                                let tr = trs[i];
                                if (tr.childElementCount == 13) {
                                    if (bookOrder[tr.children[0].children[0].children[0].children[0].children[0].innerText]) {
                                        if (tr.children[7].innerText != '--') {
                                            if (tr.children[7].innerText != '候补') {
                                                if (currentTrOrder > bookOrder[tr.children[0].children[0].children[0].children[0].children[0].innerText]) {
                                                    firstTr = tr;
                                                    currentTrOrder = bookOrder[tr.children[0].children[0].children[0].children[0].children[0].innerText];
                                                }
                                            } else {
                                                if (currentBakTrOrder > bookOrder[tr.children[0].children[0].children[0].children[0].children[0].innerText]) {
                                                    firstBakTr = tr;
                                                    currentBakTrOrder = bookOrder[tr.children[0].children[0].children[0].children[0].children[0].innerText];
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
                                firstBakTr.children[7].click();
                                return 2;
                            }
                            return 0;
                        });
                        foundAgain = matchedAgain;
                        if (foundAgain == 1) {
                            await page.waitForSelector('#normal_passenger_id', { timeout: 15000 });
                            // 勾选匹配姓名列表的乘客（normal 列表用 label for=... 关联 input）
                            const clicked = await page.$$eval('#normal_passenger_id label', (labels, names) => {
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
                            await page.$$eval('#passenge_list label', (labels, names) => {
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
                } catch {}
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
	// await page.waitForSelector('#normalPassenger_0');
    // await page.click('#normalPassenger_0');
    
    // await page.click('#qr_submit_id');
})()