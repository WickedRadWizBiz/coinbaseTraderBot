/**
 * FIX 4.4 Protocol Client & Message Definitions
 * High-Frequency Trading Execution & Order Management Foundation for Prediction Markets.
 */

export const FIX_DELIMITER = '\x01'; // SOH (Start of Header) ASCII 0x01

export enum FixTag {
  BeginString = 8,
  BodyLength = 9,
  CheckSum = 10,
  ClOrdID = 11,
  CumQty = 14,
  ExecID = 17,
  LastPx = 31,
  LastQty = 32,
  MsgSeqNum = 34,
  MsgType = 35,
  OrderID = 37,
  OrderQty = 38,
  OrdStatus = 39,
  OrdType = 40,
  OrigClOrdID = 41,
  Price = 44,
  SenderCompID = 49,
  SendingTime = 52,
  Side = 54,
  Symbol = 55,
  TargetCompID = 56,
  Text = 58,
  TimeInForce = 59,
  TransactTime = 60,
  RawDataLength = 95,
  RawData = 96,
  EncryptMethod = 98,
  ExDestination = 100,
  HeartBtInt = 108,
  TestReqID = 112,
  ResetSeqNumFlag = 141,
  MDEntryPx = 132,
  MDEntrySize = 134,
  MDEntryType = 269,
  ExecType = 150,
  LeavesQty = 151,
  MDReqID = 262,
  SubscriptionRequestType = 263,
  MarketDepth = 264,
  MDUpdateType = 265,
  Username = 553,
  Password = 554
}

export enum FixMsgType {
  Heartbeat = '0',
  TestRequest = '1',
  ResendRequest = '2',
  Reject = '3',
  SequenceReset = '4',
  Logout = '5',
  Logon = 'A',
  NewOrderSingle = 'D',
  OrderCancelRequest = 'F',
  OrderCancelReplaceRequest = 'G',
  ExecutionReport = '8',
  OrderCancelReject = '9',
  MarketDataRequest = 'V',
  MarketDataSnapshotFullRefresh = 'W',
  MarketDataIncrementalRefresh = 'X'
}

export enum FixSide {
  Buy = '1', // Long / YES
  Sell = '2' // Short / NO
}

export enum FixOrdType {
  Market = '1',
  Limit = '2',
  Stop = '3',
  StopLimit = '4'
}

export enum FixTimeInForce {
  Day = '0',
  GoodTillCancel = '1',
  ImmediateOrCancel = '3',
  FillOrKill = '4'
}

export enum FixOrdStatus {
  New = '0',
  PartiallyFilled = '1',
  Filled = '2',
  DoneForDay = '3',
  Canceled = '4',
  Replaced = '5',
  PendingCancel = '6',
  Stopped = '7',
  Rejected = '8',
  Suspended = '9',
  PendingNew = 'A',
  Calculated = 'B',
  Expired = 'C',
  AcceptedForBidding = 'D',
  PendingReplace = 'E'
}

export enum FixExecType {
  New = '0',
  DoneForDay = '3',
  Canceled = '4',
  Replaced = '5',
  PendingCancel = '6',
  Stopped = '7',
  Rejected = '8',
  Suspended = '9',
  PendingNew = 'A',
  Calculated = 'B',
  Expired = 'C',
  Restated = 'D',
  PendingReplace = 'E',
  Trade = 'F',
  TradeCorrect = 'G',
  TradeCancel = 'H',
  OrderStatus = 'I'
}

/**
 * Standard Header for FIX 4.4 Messages
 */
export interface FixHeader {
  beginString: string; // "FIX.4.4"
  bodyLength?: number;
  msgType: FixMsgType | string;
  senderCompID: string;
  targetCompID: string;
  msgSeqNum: number;
  sendingTime?: string;
}

/**
 * OrderCancelReplaceRequest (MsgType=G)
 * Used to atomically modify price, quantity, or time-in-force of a resting order without queue loss.
 */
export interface OrderCancelReplaceRequest {
  clOrdID: string;         // Tag 11: Unique identifier of replacement order
  origClOrdID: string;     // Tag 41: ClOrdID of the original order being modified
  orderID?: string;        // Tag 37: Exchange assigned order ID (if known)
  symbol: string;          // Tag 55: Instrument/Market Ticker
  side: FixSide;           // Tag 54: 1 = Buy (YES), 2 = Sell (NO)
  transactTime: string;    // Tag 60: UTC timestamp (YYYYMMDD-HH:MM:SS.sss)
  orderQty: number;        // Tag 38: Total amended quantity
  ordType: FixOrdType;     // Tag 40: 1 = Market, 2 = Limit
  price: number;           // Tag 44: Price in cents (e.g. 52 for $0.52)
  timeInForce?: FixTimeInForce; // Tag 59: 1 = GTC, 3 = IOC
  exDestination?: string;  // Tag 100: Shard destination identifier
  text?: string;           // Tag 58: Custom audit memo
}

/**
 * NewOrderSingle (MsgType=D)
 */
export interface NewOrderSingleRequest {
  clOrdID: string;
  symbol: string;
  side: FixSide;
  transactTime: string;
  orderQty: number;
  ordType: FixOrdType;
  price: number;
  timeInForce?: FixTimeInForce;
  exDestination?: string;
  text?: string;
}

/**
 * OrderCancelRequest (MsgType=F)
 */
export interface OrderCancelRequest {
  clOrdID: string;
  origClOrdID: string;
  symbol: string;
  side: FixSide;
  transactTime: string;
  orderQty?: number;
  exDestination?: string;
}

/**
 * ExecutionReport (MsgType=8)
 */
export interface FixExecutionReport {
  clOrdID: string;
  origClOrdID?: string;
  orderID: string;
  execID: string;
  execType: FixExecType;
  ordStatus: FixOrdStatus;
  symbol: string;
  side: FixSide;
  leavesQty: number;
  cumQty: number;
  lastPx?: number;
  lastQty?: number;
  price?: number;
  orderQty?: number;
  transactTime?: string;
  text?: string;
}

/**
 * Helper utilities for serializing and parsing FIX 4.4 wire protocols
 */
export class FixProtocolUtils {
  /**
   * Generates a UTC timestamp formatted for FIX Tag 52 / Tag 60 (YYYYMMDD-HH:MM:SS.sss)
   */
  public static getUtcTimestamp(d: Date = new Date()): string {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const min = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    const sss = String(d.getUTCMilliseconds()).padStart(3, '0');
    return `${yyyy}${mm}${dd}-${hh}:${min}:${ss}.${sss}`;
  }

  /**
   * Calculates the standard FIX 3-digit modulo 256 checksum (Tag 10)
   */
  public static calculateChecksum(rawMsg: string): string {
    let sum = 0;
    for (let i = 0; i < rawMsg.length; i++) {
      sum = (sum + rawMsg.charCodeAt(i)) % 256;
    }
    return sum.toString().padStart(3, '0');
  }

  /**
   * Builds an OrderCancelReplaceRequest (MsgType=G) message payload
   */
  public static buildOrderCancelReplaceMessage(
    header: FixHeader,
    req: OrderCancelReplaceRequest,
    delimiter: string = FIX_DELIMITER
  ): string {
    const fields: [number, string | number][] = [
      [FixTag.BeginString, header.beginString || 'FIX.4.4'],
      [FixTag.BodyLength, 0], // Replaced dynamically
      [FixTag.MsgType, FixMsgType.OrderCancelReplaceRequest],
      [FixTag.SenderCompID, header.senderCompID],
      [FixTag.TargetCompID, header.targetCompID],
      [FixTag.MsgSeqNum, header.msgSeqNum],
      [FixTag.SendingTime, header.sendingTime || this.getUtcTimestamp()],
      [FixTag.ClOrdID, req.clOrdID],
      [FixTag.OrigClOrdID, req.origClOrdID]
    ];

    if (req.orderID) fields.push([FixTag.OrderID, req.orderID]);
    fields.push([FixTag.Symbol, req.symbol]);
    fields.push([FixTag.Side, req.side]);
    fields.push([FixTag.TransactTime, req.transactTime || this.getUtcTimestamp()]);
    fields.push([FixTag.OrderQty, req.orderQty]);
    fields.push([FixTag.OrdType, req.ordType]);
    fields.push([FixTag.Price, req.price.toFixed(2)]);

    if (req.timeInForce) fields.push([FixTag.TimeInForce, req.timeInForce]);
    if (req.exDestination) fields.push([FixTag.ExDestination, req.exDestination]);
    if (req.text) fields.push([FixTag.Text, req.text]);

    return this.assembleWireMessage(fields, delimiter);
  }

  /**
   * Builds a NewOrderSingle (MsgType=D) message payload
   */
  public static buildNewOrderSingleMessage(
    header: FixHeader,
    req: NewOrderSingleRequest,
    delimiter: string = FIX_DELIMITER
  ): string {
    const fields: [number, string | number][] = [
      [FixTag.BeginString, header.beginString || 'FIX.4.4'],
      [FixTag.BodyLength, 0],
      [FixTag.MsgType, FixMsgType.NewOrderSingle],
      [FixTag.SenderCompID, header.senderCompID],
      [FixTag.TargetCompID, header.targetCompID],
      [FixTag.MsgSeqNum, header.msgSeqNum],
      [FixTag.SendingTime, header.sendingTime || this.getUtcTimestamp()],
      [FixTag.ClOrdID, req.clOrdID],
      [FixTag.Symbol, req.symbol],
      [FixTag.Side, req.side],
      [FixTag.TransactTime, req.transactTime || this.getUtcTimestamp()],
      [FixTag.OrderQty, req.orderQty],
      [FixTag.OrdType, req.ordType],
      [FixTag.Price, req.price.toFixed(2)]
    ];

    if (req.timeInForce) fields.push([FixTag.TimeInForce, req.timeInForce]);
    if (req.exDestination) fields.push([FixTag.ExDestination, req.exDestination]);
    if (req.text) fields.push([FixTag.Text, req.text]);

    return this.assembleWireMessage(fields, delimiter);
  }

  /**
   * Serializes a field list into a valid FIX wire format with BodyLength and Checksum
   */
  public static assembleWireMessage(
    fields: [number, string | number][],
    delimiter: string = FIX_DELIMITER
  ): string {
    const headerFields = fields.slice(2);
    const bodyStr = headerFields.map(([tag, val]) => `${tag}=${val}`).join(delimiter) + delimiter;
    const bodyLength = bodyStr.length;

    const fullMessageExceptChecksum = `8=FIX.4.4${delimiter}9=${bodyLength}${delimiter}${bodyStr}`;
    const checksum = this.calculateChecksum(fullMessageExceptChecksum);
    return `${fullMessageExceptChecksum}10=${checksum}${delimiter}`;
  }

  /**
   * Parses raw FIX wire string into key-value tag dictionary
   */
  public static parseRawFixMessage(raw: string, delimiter: string = FIX_DELIMITER): Record<number, string> {
    const tags: Record<number, string> = {};
    const tokens = raw.split(delimiter).filter(t => t.length > 0);

    for (const token of tokens) {
      const eqIdx = token.indexOf('=');
      if (eqIdx !== -1) {
        const tag = parseInt(token.substring(0, eqIdx), 10);
        const val = token.substring(eqIdx + 1);
        if (!isNaN(tag)) {
          tags[tag] = val;
        }
      }
    }
    return tags;
  }
}

/**
 * Lightweight client session state manager for high-frequency execution
 */
export class FixClientSession {
  private senderCompID: string;
  private targetCompID: string;
  private seqNumOut: number = 1;
  private seqNumIn: number = 1;
  private pendingOrders: Map<string, OrderCancelReplaceRequest | NewOrderSingleRequest> = new Map();

  constructor(senderCompID = 'AI_TRADER_PRIMARY', targetCompID = 'KALSHI') {
    this.senderCompID = senderCompID;
    this.targetCompID = targetCompID;
  }

  public getNextOutgoingSeqNum(): number {
    return this.seqNumOut++;
  }

  public recordIncomingSeqNum(num: number): void {
    if (num >= this.seqNumIn) {
      this.seqNumIn = num + 1;
    }
  }

  public createHeader(msgType: FixMsgType | string): FixHeader {
    return {
      beginString: 'FIX.4.4',
      msgType,
      senderCompID: this.senderCompID,
      targetCompID: this.targetCompID,
      msgSeqNum: this.getNextOutgoingSeqNum(),
      sendingTime: FixProtocolUtils.getUtcTimestamp()
    };
  }

  public prepareOrderCancelReplace(req: OrderCancelReplaceRequest): { wireMessage: string; clOrdID: string } {
    const header = this.createHeader(FixMsgType.OrderCancelReplaceRequest);
    const wireMessage = FixProtocolUtils.buildOrderCancelReplaceMessage(header, req);
    this.pendingOrders.set(req.clOrdID, req);
    return { wireMessage, clOrdID: req.clOrdID };
  }

  public prepareNewOrderSingle(req: NewOrderSingleRequest): { wireMessage: string; clOrdID: string } {
    const header = this.createHeader(FixMsgType.NewOrderSingle);
    const wireMessage = FixProtocolUtils.buildNewOrderSingleMessage(header, req);
    this.pendingOrders.set(req.clOrdID, req);
    return { wireMessage, clOrdID: req.clOrdID };
  }

  public getPendingOrder(clOrdID: string) {
    return this.pendingOrders.get(clOrdID);
  }

  public clearPendingOrder(clOrdID: string) {
    this.pendingOrders.delete(clOrdID);
  }
}
