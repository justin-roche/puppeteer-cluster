import Cluster from '../src/Cluster';
import * as http from 'http';
import { timeoutExecute } from '../src/util';
import { Page } from 'puppeteer';

let testServer: http.Server;

const TEST_URL = 'http://127.0.0.1:3001/';

const concurrencyTypes = [
    Cluster.CONCURRENCY_PAGE,
    Cluster.CONCURRENCY_CONTEXT,
    Cluster.CONCURRENCY_BROWSER,
];

beforeAll(async () => {
    // test server
    await new Promise((resolve) => {
        testServer = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body>puppeteer-cluster TEST</body></html>');
        }).listen(3001, '127.0.0.1', resolve);
    });
});

afterAll(() => {
    testServer.close();
});

describe('options', () => {

    async function cookieTest(concurrencyType: number) {
        const cluster = await Cluster.launch({
            puppeteerOptions: { args: ['--no-sandbox'] },
            maxConcurrency: 1,
            concurrency: concurrencyType,
        });

        const randomValue = Math.random().toString();

        cluster.task(async ({ page, data: url }) => {
            await page.goto(url);
            const cookies = await page.cookies();

            cookies.forEach(({ name, value }) => {
                if (name === 'puppeteer-cluster-testcookie' && value === randomValue) {
                    expect(true).toBe(true);
                }
            });

            await page.setCookie({
                name: 'puppeteer-cluster-testcookie',
                value: randomValue,
                url: TEST_URL,
            });
        });

        // one job sets the cookie, the other page reads the cookie
        cluster.queue(TEST_URL);
        cluster.queue(TEST_URL);

        await cluster.idle();
        await cluster.close();
    }

    test('cookie sharing in Cluster.CONCURRENCY_PAGE', async () => {
        expect.assertions(1);
        await cookieTest(Cluster.CONCURRENCY_PAGE);
    });

    test('no cookie sharing in Cluster.CONCURRENCY_CONTEXT', async () => {
        expect.assertions(0);
        await cookieTest(Cluster.CONCURRENCY_CONTEXT);
    });

    test('no cookie sharing in Cluster.CONCURRENCY_BROWSER', async () => {
        expect.assertions(0);
        await cookieTest(Cluster.CONCURRENCY_BROWSER);
    });

    // repeat remaining tests for all concurrency options

    concurrencyTypes.forEach((concurrency) => {
        describe(`concurrency: ${concurrency}`, () => {

            test('skipDuplicateUrls', async () => {
                expect.assertions(1);

                const cluster = await Cluster.launch({
                    concurrency,
                    puppeteerOptions: { args: ['--no-sandbox'] },
                    maxConcurrency: 1,
                    skipDuplicateUrls: true,
                });
                cluster.on('taskerror', (err) => {
                    throw err;
                });

                cluster.task(async ({ page, data: url }) => {
                    expect(url).toBe(TEST_URL);
                });

                cluster.queue(TEST_URL);
                cluster.queue(TEST_URL);

                await cluster.idle();
                await cluster.close();
            });

            test('skipDuplicateUrls (parallel)', async () => {
                expect.assertions(1);

                const sameUrl = 'http://www.google.com/';

                const cluster = await Cluster.launch({
                    concurrency,
                    puppeteerOptions: { args: ['--no-sandbox'] },
                    maxConcurrency: 2,
                    skipDuplicateUrls: true,
                });
                cluster.on('taskerror', (err) => {
                    throw err;
                });

                cluster.task(async ({ page, data: url }) => {
                    expect(url).toBe(sameUrl);
                });

                cluster.queue(sameUrl);
                cluster.queue(sameUrl);

                await cluster.idle();
                await cluster.close();
            });

            test('retryLimit', async () => {
                expect.assertions(4); // 3 retries -> 4 times called

                const cluster = await Cluster.launch({
                    concurrency,
                    puppeteerOptions: { args: ['--no-sandbox'] },
                    maxConcurrency: 1,
                    retryLimit: 3,
                });

                cluster.task(async ({ page, data: url }) => {
                    expect(true).toBe(true);
                    throw new Error('testing retryLimit');
                });

                cluster.queue(TEST_URL);

                await cluster.idle();
                await cluster.close();
            });

            test('waitForOne', async () => {
                const cluster = await Cluster.launch({
                    concurrency,
                    puppeteerOptions: { args: ['--no-sandbox'] },
                });
                let counter = 0;

                cluster.task(async ({ page, data: url }) => {
                    counter += 1;
                });
                cluster.queue(TEST_URL);
                cluster.queue(TEST_URL);

                expect(counter).toBe(0);
                await cluster.waitForOne();
                expect(counter).toBe(1);
                await cluster.waitForOne();
                expect(counter).toBe(2);

                await cluster.idle();
                await cluster.close();
            });

            test('retryDelay = 0', async () => {
                expect.assertions(2);
                const cluster = await Cluster.launch({
                    concurrency,
                    puppeteerOptions: { args: ['--no-sandbox'] },
                    maxConcurrency: 1,
                    retryLimit: 1,
                    retryDelay: 0,
                });

                const ERROR_URL = 'http://example.com/we-are-never-visited-the-page';

                cluster.task(async ({ page, data: url }) => {
                    if (url === ERROR_URL) {
                        throw new Error('testing retryDelay');
                    }
                });

                cluster.queue(ERROR_URL);

                const url1 = await cluster.waitForOne();
                expect(url1).toBe(ERROR_URL);

                await timeoutExecute(1000, (async () => {
                    const url2 = await cluster.waitForOne();
                    expect(url2).toBe(ERROR_URL);
                })());

                await cluster.close();
            });

            test('retryDelay > 0', async () => {
                expect.assertions(3);

                const cluster = await Cluster.launch({
                    concurrency,
                    puppeteerOptions: { args: ['--no-sandbox'] },
                    maxConcurrency: 1,
                    retryLimit: 1,
                    retryDelay: 250,
                });

                const ERROR_URL = 'http://example.com/we-are-never-visited-the-page';

                cluster.task(async ({ page, data: url }) => {
                    if (url === ERROR_URL) {
                        throw new Error('testing retryDelay');
                    }
                });

                cluster.queue(ERROR_URL);

                const url1 = await cluster.waitForOne();
                expect(url1).toBe(ERROR_URL);

                try {
                    await timeoutExecute(200, (async () => {
                        await cluster.waitForOne(); // should time out!
                    })());
                } catch (err) {
                    expect(err.message).toMatch(/Timeout/);
                }

                const url2 = await cluster.waitForOne();
                expect(url2).toBe(ERROR_URL);

                await cluster.close();
            });

            test('sameDomainDelay with one worker', async () => {
                const cluster = await Cluster.launch({
                    concurrency,
                    puppeteerOptions: { args: ['--no-sandbox'] },
                    maxConcurrency: 1,
                    sameDomainDelay: 1000,
                });
                cluster.on('taskerror', (err) => {
                    throw err;
                });

                let counter = 0;

                const FIRST_URL = 'http://example.com/we-are-never-visiting-the-page';
                const SECOND_URL = 'http://another.tld/we-are-never-visiting-the-page';

                await cluster.task(async ({ page, data: { url, counterShouldBe } }) => {
                    counter += 1;
                    expect(counter).toBe(counterShouldBe);
                });

                await cluster.queue({ url: FIRST_URL, counterShouldBe: 1 });
                await cluster.queue({ url: FIRST_URL, counterShouldBe: 3 });
                await cluster.waitForOne();
                await cluster.queue({ url: SECOND_URL, counterShouldBe: 2 });

                await cluster.idle();
                await cluster.close();
            });

            test('sameDomainDelay with multiple workers', async () => {
                const cluster = await Cluster.launch({
                    concurrency,
                    puppeteerOptions: { args: ['--no-sandbox'] },
                    maxConcurrency: 2,
                    sameDomainDelay: 1000,
                });
                cluster.on('taskerror', (err) => {
                    throw err;
                });

                let counter = 0;

                const FIRST_URL = 'http://example.com/we-are-never-visiting-the-page';
                const SECOND_URL = 'http://another.tld/we-are-never-visiting-the-page';

                await cluster.task(async ({ page, data: { url, counterShouldBe } }) => {
                    counter += 1;
                    expect(counter).toBe(counterShouldBe);
                });

                await cluster.queue({ url: FIRST_URL, counterShouldBe: 1 });
                await cluster.queue({ url: FIRST_URL, counterShouldBe: 3 });
                await cluster.waitForOne();
                await cluster.queue({ url: SECOND_URL, counterShouldBe: 2 });

                await cluster.idle();
                await cluster.close();
            });

            test('works with only functions', async () => {
                expect.assertions(4);

                const cluster = await Cluster.launch({
                    concurrency,
                    puppeteerOptions: { args: ['--no-sandbox'] },
                    maxConcurrency: 1,
                });
                cluster.on('taskerror', (err) => {
                    throw err;
                });

                await cluster.queue(async ({ page, data }: { page: any, data: any}) => {
                    expect(page).toBeDefined();
                    expect(data).toBeUndefined();
                });

                await cluster.queue('something', async ({ page, data: url }) => {
                    expect(page).toBeDefined();
                    expect(url).toBe('something');
                });

                await cluster.idle();
                await cluster.close();
            });

            test('works with a mix of task functions', async () => {
                expect.assertions(8);

                const cluster = await Cluster.launch({
                    concurrency,
                    puppeteerOptions: { args: ['--no-sandbox'] },
                    maxConcurrency: 1,
                });
                cluster.on('taskerror', (err) => {
                    throw err;
                });

                await cluster.task(async ({ page, data: url }) => {
                    // called two times
                    expect(page).toBeDefined();
                    expect(url).toBe('works');
                });

                await cluster.queue('works too', async ({ page, data: url }) => {
                    expect(page).toBeDefined();
                    expect(url).toBe('works too');
                });
                cluster.queue('works');
                await cluster.queue(async ({ page, data }: { page: any, data: any}) => {
                    expect(page).toBeDefined();
                    expect(data).toBeUndefined();
                });
                cluster.queue('works');

                await cluster.idle();
                await cluster.close();
            });

            test('works with complex objects', async () => {
                const cluster = await Cluster.launch({
                    concurrency,
                    puppeteerOptions: { args: ['--no-sandbox'] },
                    maxConcurrency: 1,
                });
                cluster.on('taskerror', (err) => {
                    throw err;
                });

                await cluster.task(async ({ page, data }) => {
                    expect(data.a.b).toBe('test');
                });
                cluster.queue({ a: { b: 'test' } });

                await cluster.idle();
                await cluster.close();
            });

            // TODO test('throws when no task function given');
        });
    });
    // end of tests for all concurrency options

    describe('monitoring', () => {
        // setup and cleanup are copied from Display.test.ts
        let write: any;
        let log: any;
        let output = '';

        function cleanup() {
            process.stdout.write = write;
            console.log = log;
        }

        beforeEach(() => {
            output = '';
            write = process.stdout.write;
            log = console.log;

            (process.stdout.write as any) = (str: string) => {
                output += str;
            };

            console.log = (str) => {
                output += `${str}\n`;
            };
        });

        afterEach(cleanup);

        test('monitoring enabled', async () => {
            const cluster = await Cluster.launch({
                concurrency: Cluster.CONCURRENCY_CONTEXT,
                puppeteerOptions: { args: ['--no-sandbox'] },
                maxConcurrency: 1,
                monitor: true,
            });
            cluster.on('taskerror', (err) => {
                throw err;
            });

            cluster.task(async () => {
                await new Promise(resolve => setTimeout(resolve, 550));
            });

            cluster.queue(TEST_URL);

            // there should be at least one logging call in a 500ms interval
            output = '';
            await new Promise(resolve => setTimeout(resolve, 510));
            const numberOfLines = (output.match(/\n/g) || []).length;
            expect(numberOfLines).toBeGreaterThan(5);

            await cluster.idle();
            await cluster.close();
        });
    });

});

describe('Repair', () => {
    concurrencyTypes.forEach((concurrency) => {

        describe(`concurrency: ${concurrency}`, () => {
            test('Repair unexpected crash', async () => {

                const cluster = await Cluster.launch({
                    concurrency,
                    puppeteerOptions: { args: ['--no-sandbox'] },
                    maxConcurrency: 1,
                });
                cluster.on('taskerror', (err) => {
                    throw err;
                });

                // first job closes the browser
                cluster.queue(async ({ page }: { page: Page }) => {
                    // close browser
                    await page.browser().close();

                    // check if its actually crashed
                    await expect(
                        page.goto(TEST_URL),
                    ).rejects.toMatchObject({
                        message: expect.stringMatching(/Protocol error/),
                    });
                });

                // second one should still work after the crash
                cluster.queue(async ({ page }: { page: Page }) => {
                    page.goto(TEST_URL); // if this does not throw, we are happy
                    expect(true).toBe(true);
                });

                await cluster.idle();
                await cluster.close();
            });
        });
    });
});
