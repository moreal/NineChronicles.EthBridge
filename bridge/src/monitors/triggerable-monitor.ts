import { Monitor } from ".";
import { captureException } from "@sentry/node";
import { TransactionLocation } from "../types/transaction-location";
import { BlockHash } from "../types/block-hash";
import { Integration } from "../integrations";

function delay(ms: number): Promise<void> {
    return new Promise(resolve => {
        setTimeout(() => { resolve() }, ms);
    })
}

type ProcessRemainsResult<TEventData> = { nextBlockIndex: number, remainedEvents: RemainedEvent<TEventData>[] }
type RemainedEvent<TEventData> = { blockHash: string; events: (TEventData & TransactionLocation)[]; };

export abstract class TriggerableMonitor<TEventData> extends Monitor<TEventData & TransactionLocation> {
    private latestBlockNumber: number | undefined;
    private updatedAt: Date | undefined;

    private readonly _latestTransactionLocation: TransactionLocation | null;
    private readonly _delayMilliseconds: number;
    private readonly _integrations: Integration[];

    constructor(latestTransactionLocation: TransactionLocation | null, delayMilliseconds: number = 15 * 1000, integrations?: Integration[]) {
        super();

        this._latestTransactionLocation = latestTransactionLocation;
        this._delayMilliseconds = delayMilliseconds;
        this._integrations = integrations || [];
    }

    async * loop(): AsyncIterableIterator<{ blockHash: BlockHash, events: (TEventData & TransactionLocation)[] }> {
        if (this._latestTransactionLocation !== null) {
            const { nextBlockIndex, remainedEvents } = await this.processRemains(this._latestTransactionLocation);

            for (const remainedEvent of remainedEvents) {
                yield remainedEvent;
            }

            this.latestBlockNumber = nextBlockIndex;
        } else {
            this.latestBlockNumber = await this.getTipIndex();
        }

        this.updatedAt = new Date();

        while(true) {
            try {
                const tipIndex = await this.getTipIndex();
                this.debug("Try to check trigger at", this.latestBlockNumber + 1);
                if (this.latestBlockNumber + 1 <= tipIndex) {
                    const trigerredBlockIndexes  = this.triggerredBlocks(this.latestBlockNumber + 1);

                    for (const blockIndex of trigerredBlockIndexes) {
                        this.debug("Execute triggerred block #", blockIndex);
                        const blockHash = await this.getBlockHash(blockIndex);

                        yield { blockHash, events: await this.getEvents(blockIndex) }
                    }

                    this.latestBlockNumber += 1;
                    this.updatedAt = new Date();
                } else {
                    this.debug(`Skip check trigger current: ${this.latestBlockNumber} / tip: ${tipIndex}`);

                    const current = new Date();
                    const TIMEOUT = 5 * 60 * 1000;  // 5 minutes.
                    if ((+current - +this.updatedAt) > TIMEOUT) {
                        for (let integration of this._integrations) {
                            integration.error(`${this.constructor.name} is not updated for ${TIMEOUT / 1000 / 60} minutes.`, {
                                latestBlockNumber: this.latestBlockNumber,
                            });
                        }
                    }

                    await delay(this._delayMilliseconds);
                }
            } catch (error) {
                this.error("Ignore and continue loop without breaking though unexpected error occurred:", error);
                captureException(error);
            }
        }
    }

    protected abstract processRemains(transactionLocation: TransactionLocation): Promise<ProcessRemainsResult<TEventData>>;

    protected abstract triggerredBlocks(blockIndex: number): number[];

    private debug(message?: any, ...optionalParams: any[]): void {
        console.debug(`[${this.constructor.name}]`, message, ...optionalParams);
    }

    private error(message?: any, ...optionalParams: any[]): void {
        console.error(`[${this.constructor.name}]`, message, ...optionalParams);
    }

    protected abstract getBlockIndex(blockHash: string): Promise<number>;

    protected abstract getBlockHash(blockIndex: number): Promise<string>;

    protected abstract getTipIndex(): Promise<number>;

    protected abstract getEvents(blockIndex: number): Promise<(TEventData & TransactionLocation)[]>;
}
