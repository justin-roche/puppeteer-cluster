
import AbstractBrowser from './AbstractBrowser';
import * as puppeteer from 'puppeteer';

import { debugGenerator, timeoutExecute } from '../util';
const debug = debugGenerator('BrowserPage');

const BROWSER_TIMEOUT = 5000;

export default class ConcurrencyPage extends AbstractBrowser {

    private chrome: puppeteer.Browser | null = null;

    private repairing: boolean = false;
    private repairRequested: boolean = false;
    private openInstances: number = 0;
    private waitingForRepairResolvers: (() => void)[] = [];

    public async init() {
        this.chrome = await puppeteer.launch(this.options);
    }

    public async close() {
        await (<puppeteer.Browser>this.chrome).close();
    }

    private async startRepair() {
        if (this.openInstances !== 0 || this.repairing) {
            // already repairing or there are still pages open? -> cancel
            await new Promise(resolve => this.waitingForRepairResolvers.push(resolve));
            return;
        }

        this.repairing = true;
        debug('Starting repair');

        try {
            // will probably fail, but just in case the repair was not necessary
            await (<puppeteer.Browser>this.chrome).close();
        } catch (e) {
            debug('Unable to close browser.');
        }

        try {
            this.chrome = await puppeteer.launch(this.options);
        } catch (err) {
            throw new Error('Unable to restart chrome.');
        }
        this.repairRequested = false;
        this.repairing = false;
        this.waitingForRepairResolvers.forEach(resolve => resolve());
        this.waitingForRepairResolvers = [];
    }

    public async workerInstance() {
        let page: puppeteer.Page;

        return {
            instance: async () => {
                if (this.repairRequested) {
                    await this.startRepair();
                }

                await timeoutExecute(BROWSER_TIMEOUT, (async () => {
                    page = await (<puppeteer.Browser>this.chrome).newPage();
                })());
                this.openInstances += 1;

                return {
                    page,

                    close: async () => {
                        this.openInstances -= 1; // decrement first in case of error
                        await timeoutExecute(BROWSER_TIMEOUT, page.close());

                        if (this.repairRequested) {
                            await this.startRepair();
                        }
                    },
                };
            },

            close: async () => {

            },

            repair: async () => {
                debug('Repair requested');
                this.repairRequested = true;
                await this.startRepair();
            },
        };
    }

}
