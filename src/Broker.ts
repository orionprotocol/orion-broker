import {BrokerHub, CreateSubOrder, SubOrderStatus, SubOrderStatusAccepted,} from "./hub/BrokerHub";
import {Db, DbSubOrder} from "./db/Db";
import {log} from "./log";
import {Balances, BlockchainOrder, Dictionary, Liability, Status, SubOrder, Trade, Transaction} from "./Model";
import BigNumber from "bignumber.js";
import {WebUI} from "./ui/WebUI";
import {Connectors, ExchangeResolve} from "./connectors/Connectors";
import {OrionBlockchain} from "./OrionBlockchain";
import {Settings} from "./Settings";
import {ExchangeWithdrawStatus} from "./connectors/Connector";
import Web3 from "web3";

export class Broker {
    settings: Settings;
    brokerHub: BrokerHub;
    db: Db;
    webUI: WebUI;
    connector: Connectors;
    orionBlockchain: OrionBlockchain;
    lastBalances: Dictionary<Dictionary<BigNumber>> = {};

    constructor(settings: Settings, brokerHub: BrokerHub, db: Db, webUI: WebUI, connector: Connectors) {
        this.settings = settings;
        this.brokerHub = brokerHub;
        this.db = db;
        this.webUI = webUI;
        this.connector = connector;

        brokerHub.onCreateSubOrder = this.onCreateSubOrder.bind(this);
        brokerHub.onCancelSubOrder = this.onCancelSubOrder.bind(this);
        brokerHub.onCheckSubOrder = this.onCheckSubOrder.bind(this);
        brokerHub.onSubOrderStatusAccepted = this.onSubOrderStatusAccepted.bind(this);
        brokerHub.onReconnect = this.connectToAggregator.bind(this);
    }

    onSubOrderStatusAccepted = async (data: SubOrderStatusAccepted): Promise<void> => {
        const id = data.id;

        const dbSubOrder: DbSubOrder = await this.db.getSubOrderById(id);

        if (!dbSubOrder) {
            throw new Error(`Suborder ${id} not found`);
        }

        const rejectedByAggregator = (data.status === Status.REJECTED) && (dbSubOrder.status !== Status.REJECTED);
        if (rejectedByAggregator) {
            log.error(`Order ${id} rejected by aggregator`);
        }

        const isStatusFinal = dbSubOrder.status !== Status.PREPARE && dbSubOrder.status !== Status.ACCEPTED;
        if (rejectedByAggregator || (dbSubOrder.status === data.status && isStatusFinal)) {
            dbSubOrder.sentToAggregator = true;
            await this.db.updateSubOrder(dbSubOrder);
            this.webUI.sendToFrontend(dbSubOrder);
        }
    }

    async onCheckSubOrder(id: number): Promise<SubOrderStatus> {
        const dbSubOrder: DbSubOrder = await this.db.getSubOrderById(id);

        if (!dbSubOrder) {
            return {
                id: id,
                status: null,
                filledAmount: '0'
            }
        }

        const trades: Trade[] = dbSubOrder.exchangeOrderId ? (await this.db.getSubOrderTrades(dbSubOrder.exchange, dbSubOrder.exchangeOrderId)) : [];

        if (trades.length > 1) {
            throw new Error('Cant support multiple trades yet');
        }

        const blockchainOrder: BlockchainOrder = trades.length === 0 ? undefined : (await this.orionBlockchain.signTrade(dbSubOrder, trades[0]));

        return {
            id: id,
            status: dbSubOrder.status,
            filledAmount: dbSubOrder.filledAmount.toString(),
            blockchainOrder: blockchainOrder
        }
    }

    async onCreateSubOrder(request: CreateSubOrder): Promise<SubOrderStatus> {
        const oldSubOrder = await this.db.getSubOrderById(request.id);

        if (oldSubOrder) {
            log.log('Suborder ' + request.id + ' already created');
            return this.onCheckSubOrder(request.id);
        }

        const dbSubOrder: DbSubOrder = {
            id: request.id,
            symbol: request.symbol,
            side: request.side,
            price: request.price,
            amount: request.amount,
            exchange: request.exchange,
            timestamp: Date.now(),
            status: Status.PREPARE,
            filledAmount: new BigNumber(0),
            sentToAggregator: false
        }
        await this.db.insertSubOrder(dbSubOrder);

        log.log('Suborder inserted');

        const subOrder: SubOrder = await this.connector.submitSubOrder(request.exchange, dbSubOrder.id, dbSubOrder.symbol, dbSubOrder.side, dbSubOrder.amount, dbSubOrder.price);

        dbSubOrder.exchangeOrderId = subOrder.exchangeOrderId;
        dbSubOrder.timestamp = subOrder.timestamp;
        dbSubOrder.status = subOrder.status;
        await this.db.updateSubOrder(dbSubOrder);

        log.log('Suborder updated ', JSON.stringify(dbSubOrder));

        this.webUI.sendToFrontend(dbSubOrder);

        return this.onCheckSubOrder(dbSubOrder.id);
    };

    async onCancelSubOrder(id: number): Promise<SubOrderStatus> {
        const dbSubOrder: DbSubOrder = await this.db.getSubOrderById(id);

        if (!dbSubOrder) throw new Error('Cant find suborder ' + dbSubOrder.id);

        if (dbSubOrder.status === Status.PREPARE) {
            // todo
        } else if (dbSubOrder.status === Status.ACCEPTED) {
            const cancelResult = await this.connector.cancelSubOrder(dbSubOrder);

            if (!cancelResult) throw new Error('Cant cancel suborder ' + dbSubOrder.id);

            dbSubOrder.status = Status.CANCELED;

            await this.db.updateSubOrder(dbSubOrder);
            this.webUI.sendToFrontend(dbSubOrder);

        } else {
            log.log('Cant cancel suborder in status ' + dbSubOrder.status);
        }

        return this.onCheckSubOrder(dbSubOrder.id);
    };

    sendUpdateBalance(balances: Dictionary<ExchangeResolve<Balances>>): Promise<void> {
        const exchanges: Dictionary<Dictionary<string>> = {};
        this.lastBalances = {};

        for (let exchange in balances) {
            const exchangeBalances: ExchangeResolve<Balances> = balances[exchange];
            if (exchangeBalances.error) {
                log.error(exchange + ' balances', exchangeBalances.error);
            } else {
                this.lastBalances[exchange] = {};
                exchanges[exchange] = {};
                for (let currency in exchangeBalances.result) {
                    const v = exchangeBalances.result[currency];
                    exchanges[exchange][currency] = v.toString();
                    this.lastBalances[exchange][currency] = v;
                }
            }
        }
        this.webUI.lastBalancesJson = JSON.stringify(exchanges);
        return this.brokerHub.sendBalances(exchanges);
    }

    startUpdateBalances(): void {
        setInterval(async () => {
            try {
                const balances = await this.connector.getBalances()
                await this.sendUpdateBalance(balances);
            } catch (e) {
                log.error('Balances', e)
            }
        }, 10000);
    }

    startCheckSubOrders(): void {
        setInterval(async () => {
            try {
                const subOrdersToResend = await this.db.getSubOrdersToResend();
                for (let subOrder of subOrdersToResend) {
                    await this.brokerHub.sendSubOrderStatus(await this.onCheckSubOrder(subOrder.id));
                }

                const openSubOrders = await this.db.getSubOrdersToCheck();
                await this.connector.checkSubOrders(openSubOrders);
            } catch (e) {
                log.error('Suborders check', e)
            }
        }, this.settings.production ? 10000 : 3000);
    }

    startCheckWithdraws(): void {
        setInterval(async () => {
            try {
                const openWithdraws = await this.db.getWithdrawsToCheck();
                const withdrawsStatuses: ExchangeWithdrawStatus[] = await this.connector.checkWithdraws(openWithdraws);
                for (let status of withdrawsStatuses) {
                    await this.db.updateWithdrawStatus(status.exchangeWithdrawId, status.status);
                }
            } catch (e) {
                log.error('Withdraw check', e)
            }
        }, 3000);
    }

    async manageLiability(liability: Liability): Promise<void> {
        const now = Date.now() / 1000;
        if (liability.outstandingAmount.isNegative() && (now - liability.timestamp > this.settings.duePeriodSeconds)) {
            const assetName = liability.assetName;
            const amount = liability.outstandingAmount.abs();

            if ((await this.db.getPendingTransactions(assetName)).length) {
                return
            }
            if ((await this.db.getWithdrawsToCheck(assetName)).length) {
                return
            }

            const balance = await this.orionBlockchain.getBalance();
            const assetBalance = balance[assetName];
            if (assetBalance.gte(amount)) {
                await this.deposit(amount, assetName);
            } else {
                const remaining = assetBalance.minus(amount);
                const exchange = this.getExchangeForWithdraw(remaining, assetName);
                if (exchange) {
                    await this.withdraw(exchange, remaining, assetName);
                } else {
                    log.log(`Need to make a ${assetName} deposit but there is not enough amount on the wallet and exchanges`)
                }
            }
        }
    }

    startCheckLiabilities(): void {
        setInterval(async () => {
            try {
                const liabilities: Liability[] = await this.orionBlockchain.getLiabilities();
                for (let l of liabilities) {
                    await this.manageLiability(l);
                }
            } catch (e) {
                log.error('Liabilities check', e)
            }
        }, 3000);
    }

    startCheckTransactions(): void {
        setInterval(async () => {
            try {
                const pendingTransactions: Transaction[] = await this.db.getPendingTransactions();
                for (let tx of pendingTransactions) {
                    const status = await this.orionBlockchain.getTransactionStatus(tx.transactionHash);
                    if (status !== tx.status) {
                        if (status === 'OK' || status === 'FAIL') {
                            await this.db.updateTransactionStatus(tx.transactionHash, status);
                            log.log('Tx ' + tx.method + ' ' + tx.amount.toString() + ' ' + tx.asset + ' ' + status);
                        }
                    }
                }
            } catch (e) {
                log.error('Transactions check', e)
            }
        }, 3000);
    }

    async connectToAggregator(): Promise<void> {
        try {
            const time = Date.now();
            const signature = await this.orionBlockchain.sign(time.toString());
            await this.brokerHub.connect({address: this.orionBlockchain.address, time, signature});
        } catch (e) {
            log.error('Failed to connect to aggregator ', e);
        }
    }

    async connectToOrion(): Promise<void> {
        if (this.settings.privateKey) {
            this.orionBlockchain = new OrionBlockchain(this.settings);
            await this.orionBlockchain.initContracts();
            await this.connectToAggregator();
            this.startUpdateBalances();
            this.startCheckSubOrders();
            // this.startCheckWithdraws();
            // this.startCheckLiabilities();
            // this.startCheckTransactions();
        }
    }

    // TRADE

    async onTrade(trade: Trade): Promise<void> {
        try {
            const dbSubOrder: DbSubOrder = await this.db.getSubOrder(trade.exchange, trade.exchangeOrderId);

            if (!dbSubOrder) {
                throw new Error(`Suborder ${trade.exchangeOrderId} in ${trade.exchange} not found`);
            }

            if (!dbSubOrder.amount.eq(trade.amount)) {
                throw new Error('Partially trade not supported yet');
            }

            dbSubOrder.filledAmount = trade.amount;
            dbSubOrder.status = Status.FILLED;

            await this.db.insertTrade(trade);
            await this.db.updateSubOrder(dbSubOrder);

            log.log('Check suborder', dbSubOrder);

            await this.brokerHub.sendSubOrderStatus(await this.onCheckSubOrder(dbSubOrder.id));
            this.webUI.sendToFrontend(dbSubOrder);
        } catch (e) {
            log.error("Error during Trade callback", e);
        }
    }

    // DEPOSIT/WITHDRAW

    getExchangeForWithdraw(amount: BigNumber, assetName: string): string | undefined {
        for (let exchange in this.lastBalances) {
            if (this.lastBalances.hasOwnProperty(exchange)) {
                if (this.lastBalances[exchange][assetName].gte(amount)) {
                    return exchange;
                }
            }
        }
        return undefined;
    }

    async withdraw(exchange: string, amount: BigNumber, assetName: string): Promise<void> {
        const exchangeWithdrawId: string = await this.connector.withdraw(exchange, assetName, amount, this.orionBlockchain.address);
        if (exchangeWithdrawId) {
            await this.db.insertWithdraw({
                exchangeWithdrawId,
                exchange,
                currency: assetName,
                amount,
                status: 'pending'
            })
        }
    }

    async approve(amount: BigNumber, tokenName: string): Promise<void> {
        log.log('Approving ' + amount.toString() + ' ' + tokenName);
        const transaction: Transaction = await this.orionBlockchain.approveERC20(amount, tokenName);
        await this.db.insetTransaction(transaction);
    }

    async deposit(amount: BigNumber, assetName: string): Promise<void> {
        log.log('Depositing ' + amount.toString() + ' ' + assetName);
        let transaction: Transaction;
        if (assetName === 'ETH') {
            transaction = await this.orionBlockchain.depositETH(amount);
        } else {
            const nonce = await this.orionBlockchain.getNonce();
            await this.orionBlockchain.approveERC20(amount, assetName, nonce);
            transaction = await this.orionBlockchain.depositERC20(amount, assetName, nonce + 1);
        }
        await this.db.insetTransaction(transaction);
    }

    async lockStake(amount: BigNumber): Promise<void> {
        log.log('Staking ' + amount.toString() + ' ORN');
        const transaction: Transaction = await this.orionBlockchain.lockStake(amount);
        await this.db.insetTransaction(transaction);
    }
}