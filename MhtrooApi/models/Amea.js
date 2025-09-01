import mongoose from 'mongoose';
import pkg from 'mongoose-field-encryption';
const { fieldEncryption } = pkg;
import dotenv from 'dotenv';

dotenv.config({ path: './.env' });
const emailSchema = new mongoose.Schema({
  value: { type: String, default: '' },
  active: { type: Number, default: 0 }
});
emailSchema.plugin(fieldEncryption, {
  fields: ['value'],
  secret: process.env.SECRETPHRASE
});

const phoneNumberSchema = new mongoose.Schema({
  value: { type: String, default: '' },
  active: { type: Number, default: 0 }
});

phoneNumberSchema.plugin(fieldEncryption, {
  fields: ['value'],
  secret: process.env.SECRETPHRASE
});

const landNumberSchema = new mongoose.Schema({
  value: { type: String, default: '' },
  active: { type: Number, default: 0 }
});
landNumberSchema.plugin(fieldEncryption, {
  fields: ['value'],
  secret: process.env.SECRETPHRASE
});

const caretakerSchema = new mongoose.Schema({
  carename: { type: String, default: ' ' },
  caresurname: { type: String, default: ' ' },
  careemail: { type: String, default: ' ' },
  carephone: { type: String, default: ' ' },
  caredescription: { type: String, default: ' ' },
  parent: { type: Number, default: 0 }
});
caretakerSchema.plugin(fieldEncryption, {
  fields: ['carename', 'caresurname', 'careemail', 'carephone'],
  secret: process.env.SECRETPHRASE
});

const ameaSchema = new mongoose.Schema({
  name: { type: String },
  surname: { type: String },
  email: emailSchema,
  phoneNumber: phoneNumberSchema,
  landNumber: landNumberSchema,
  mandatoryCommunication: { type: String },
  loc: {
    type: { type: String },
    coordinates: { type: [] }
  },
  region: {
    administrative: { type: String },
    municipality: { type: String }
  },
  disabilities: { type: Array },
  disabilitiesDesc: { type: String },
  disabilityPct: { type: Number },
  floor: { type: Number },
  owner: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Account' }],
  club: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Clubs' }],
  birthday: { type: Date },
  created: { type: Date, default: new Date() },
  updated: { type: Date },
  address: { type: String },
  caretaker: caretakerSchema,
  status: { type: String }, // pending, cancelled, active
  group_club: { type: String, default: '' },
  activity_problem: { type: Number, default: 0 },
  cardAmeaNumber: { type: String, default: '' },
  verifyUser: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Account' }],
  verifyClub: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Clubs' }],
  mustVerify: { type: Boolean, default: false }
});

ameaSchema.plugin(fieldEncryption, {
  fields: [
    'name',
    'surname',
    'email.value',
    'phoneNumber.value',
    'landNumber.value',
    'caretaker.carename',
    'caretaker.caresurname',
    'caretaker.careemail',
    'caretaker.carephone'
  ],
  secret: process.env.SECRETPHRASE
});

ameaSchema.index({ 'loc.coordinates': '2dsphere' });

const Amea = mongoose.model('Amea', ameaSchema);
export default Amea;