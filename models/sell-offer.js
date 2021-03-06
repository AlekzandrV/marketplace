'use strict';

const assert = require('assert');
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const dcf = require('../lib/dcf');
const promisify = require('../lib/promisify');

const OfferStatusEnum = ['blank', 'preplaced', 'placed', 'failed', 'canceled', 'closed'];

const SellOfferSchema = new Schema({
  trader: {type: Schema.Types.ObjectId, ref: 'Trader', required: true},
  assetId: {type: String, required: true},
  cessionId: {type: String, required: false},
  assetClass: {type: String, required: true},
  bookValue: {type: Number, required: true},
  totalAssetBookValue: {type: Number, required: true},
  bookDate: {type: Date, required: true},
  minPriceRate: {type: Number, required: true},
  maxSharedAPR: {type: Number, required: true},
  dividable: {type: Boolean, 'default': true},
  status: {type: String, enum: OfferStatusEnum, required: true},
  expired: {type: Date, required: true},
  updated: {type: Date, 'default': Date.now},
  relativeFlows: [{value: Number, date: Date}],
  cachedPrices: Schema.Types.Mixed,
  traders: [{type: Schema.Types.ObjectId, ref: 'Trader'}],
  pendingCommitments: [{type: Schema.Types.ObjectId, ref: 'Commitment'}]
});

SellOfferSchema.methods.getPrice = SellOffer__getPrice;
SellOfferSchema.methods.place = SellOffer__place;
SellOfferSchema.virtual('assetPartRatio')
  .get(SellOfferSchema__getAssetPartRatio);

const SellOffer = mongoose.model('SellOffer', SellOfferSchema);

module.exports = exports = {
  SellOffer: SellOffer
}

///////////////////////////////////////////////////////////////////////////////
// Implemetation
//

const days = dcf.days;

function SellOffer__getPrice(rate, rateType) {

  let rates = normalizeRate(rate, rateType);
  let r = rates.r + 1;
  rate = rates.rate;

  let d0 = this.bookDate || new Date();
  let cacheName = 'r' + Math.round(rate * 10000000000);
  this.cachedPrices = this.cachedPrices || {};
  let res = this.cachedPrices[cacheName];

  if (typeof(res) === 'undefined') {
    res = this.relativeFlows.reduce(
      (S, p) => S + p.value / Math.pow(r, days(p.date, d0)),
      0
    );
    this.set('cachedPrices.' + cacheName, res);
  }

  return res;

};

function normalizeRate(rate, rateType) {
  rateType = rateType || 'annual'; // monthly | daily
  let r;

  switch (rateType) {
    case 'monthly': r = rate / 30.4; rate *= 12; break;
    case 'daily': r = rate; rate *= 365; break;
    case 'annual':
    default:
      r = rate / 365;
  }

  return {
    rate: rate, // annual
    r: r // daily
  }
}


function SellOffer__place(callback) {

  callback = arguments[arguments.length - 1];
  if (!callback || !(callback instanceof Function)) {
    return promisify(SellOffer__place, this, arguments);
  }

  let BuyOffer = mongoose.model('BuyOffer');
  let Commitment = mongoose.model('Commitment');
  let s = this, commitment;

  try {
    assert.notEqual(s.status, 'closed');
    assert.ok(s.bookValue > 0);
  } catch(err) {
    return callback(
      new Error('Status of SellOffer doesn\'t allow to place it on marketplace')
    );
  }


  this.status = 'preplaced';
  this.updated = new Date();
  return this.save()
    .then(()=>{
      let q = {
        status: 'placed',
        assetClasses: s.assetClass,
        expired: {$gt: new Date()},
        intermediaryAPR: {$lte: s.maxSharedAPR},
        trader: {$nin: s.traders.concat(s.trader)}
      };

      // if the Asset is not dividable and it is still whole
      // we should find Buy-Offers that buys whole loans only
      if (!s.dividable && s.assetPartRatio === 1) {
        q.buyWholeAsset = true;
      };

      const cursor = BuyOffer.find(q).sort('updated').cursor();

      cursor.on('data', (b)=>{
        cursor.pause();
        Commitment.create(s, b)
          .then(
            (c)=>{
              commitment = c;
              return c.process()
            },
            (e)=>{
              console.log("%s <=> %s -- %s",
                s.assetId, b.portfolioId, e);
            })
          .then(
            (c)=>{
              if (c) console.log("%s: %s <=> %s -- inv: $%d, aP: $%d, bV: $%d, ]> $%d, -- %s",
                c._id, c.sellOffer.assetId, c.buyOffer.portfolioId,
                c.investment, c.assetPrice, c.bookValue,
                c.intermediaryMargin,
                c.status
              );
              return SellOffer.findById(s._id)
            },
            (e)=>{
              let c = commitment;
              if (!c) console.dir(e);
              else console.log("%s: %s <=> %s -- inv: %d, aP: %d, bV: %d ]> %d -- %s: %s > %s",
                c._id, c.sellOffer.assetId, c.buyOffer.portfolioId,
                c.investment, c.assetPrice, c.bookValue,
                c.intermediaryMargin,
                c.status, c.statusDescription, e
              )

              return SellOffer.findById(s._id);
            }
          )
          .then((ss)=>{
            s = ss;
            if (s.status === 'closed' || s.bookValue === 0) {
              return cursor.close().then(
                ()=>callback(null, s)
              );
            }
            return cursor.resume();
          })
          .catch(err=>{
            console.log(err);
            return cursor.resume()
          })
      });

      const processEnd = () => {
        SellOffer.findById(s._id).then((ss)=>{
          if (ss.status === 'preplaced') {
            ss.status = 'placed';
            ss.updated = new Date();
            return ss.save(callback);
          }
          return callback(null, ss);
        })
      };

      cursor.on('error', (err) => {
        console.log('Cursor error: '+err);
      });

      return cursor.on('end',  processEnd);

    })
    .catch((err) => {
      console.dir(err);
      return callback(err);
    });
}

function SellOfferSchema__getAssetPartRatio() {
  return this.bookValue / this.totalAssetBookValue;
}
