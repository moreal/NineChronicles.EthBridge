import { IHeadlessGraphQLClient } from "./interfaces/headless-graphql-client";
import { INCGTransfer } from "./interfaces/ncg-transfer";
import { TxId } from "./types/txid";
import { Mutex } from "async-mutex";
import { encode } from "bencodex";
import web3 from "web3";
import crypto from "crypto";
import { KMSNCGSigner } from "./kms-ncg-signer";
import { Address } from "./types/address";
import Decimal from "decimal.js";

export class NCGKMSTransfer implements INCGTransfer {
    private readonly _headlessGraphQLCLients: IHeadlessGraphQLClient[];
    private readonly _mutex: Mutex;
    private readonly _signer: KMSNCGSigner;

    /**
     * The address of sender;
     */
    private readonly _address: Address;
    private readonly _publicKey: string;
    private readonly _minters: [Address];

    /**
     *
     * @param headlessGraphQLCLients GraphQL clients to create unsigned tx, attach unsigned tx with signature and stage tx.
     * @param address An address to use in transaction as sender.
     * @param publicKey base64 encoded public key to use in transaction.
     * @param minters A list of minters' addresses.
     * @param kmsSigner A signer to sign transaction
     */
    constructor(
        headlessGraphQLCLients: IHeadlessGraphQLClient[],
        address: Address,
        publicKey: string,
        minters: [Address],
        kmsSigner: KMSNCGSigner
    ) {
        this._headlessGraphQLCLients = headlessGraphQLCLients;
        this._address = address;
        this._publicKey = publicKey;
        this._minters = minters;
        this._mutex = new Mutex();
        this._signer = kmsSigner;
    }

    private get headlessGraphQLClient(): IHeadlessGraphQLClient {
        return this._headlessGraphQLCLients[0];
    }

    async transfer(
        address: string,
        amount: string,
        memo: string | null
    ): Promise<TxId> {
        // If 0.01 came as `amount`, expect 1.
        // If 50.00 came as `amount`, expect 5000.
        // If 50.011 came as `amount`, expect 5001.
        const ncgAmount = new Decimal(amount).mul(100).floor().toNumber();
        return await this._mutex.runExclusive(async () => {
            // FIXME: request unsigned transaction builder API to NineChronicles.Headless developer
            //        and remove these lines.
            const plainValue = {
                type_id: "transfer_asset3",
                values: {
                    amount: [
                        {
                            decimalPlaces: Buffer.from([0x02]),
                            minters: this._minters.map((x) =>
                                Buffer.from(web3.utils.hexToBytes(x))
                            ),
                            ticker: "NCG",
                        },
                        ncgAmount,
                    ],
                    ...(memo === null ? {} : { memo }),
                    recipient: Buffer.from(web3.utils.hexToBytes(address)),
                    sender: Buffer.from(web3.utils.hexToBytes(this._address)),
                },
            };
            const unsignedTx =
                await this.headlessGraphQLClient.createUnsignedTx(
                    encode(plainValue).toString("base64"),
                    this._publicKey
                );
            const tx = await this._signer.sign(
                Buffer.from(unsignedTx, "base64").toString("hex")
            );
            const stageResults = await Promise.all(
                this._headlessGraphQLCLients.map((client) =>
                    client
                        .stageTx(Buffer.from(tx, "hex").toString("base64"))
                        .then((success) => {
                            console.log(
                                `It was ${success} to stage ${tx} to ${client.endpoint} endpoint`
                            );
                            return success;
                        })
                        .catch((error) => {
                            console.error(error);
                            return false;
                        })
                )
            );
            const successAtLeastOne = stageResults.reduce((a, b) => a || b);
            if (!successAtLeastOne) {
                throw new Error("Failed to stage transaction");
            }
            const txId = crypto
                .createHash("sha256")
                .update(tx, "hex")
                .digest()
                .toString("hex");
            return txId;
        });
    }
}
