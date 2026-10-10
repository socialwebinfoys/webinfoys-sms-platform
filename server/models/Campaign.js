// Campaign model. A campaign is an ordered sequence of message steps; each step
// has a message body and a delay before it is sent. (Actually sending/scheduling
// is a later phase — this model just stores the sequence definition.)
const mongoose = require('mongoose');

// One step in the sequence. Order is the array position.
const stepSchema = new mongoose.Schema(
  {
    body: {
      type: String,
      required: [true, 'Step body is required'],
    },
    // Delay before this step is sent, expressed as a value + unit. Interpreted
    // by the automation engine in a later phase; here it is just stored.
    delayValue: {
      type: Number,
      default: 0,
      min: [0, 'Delay cannot be negative'],
    },
    delayUnit: {
      type: String,
      enum: ['minutes', 'hours', 'days'],
      default: 'hours',
    },
    // Optional link to the Template this step was created from (for reference).
    template: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Template',
    },
  },
  { _id: true }
);

const campaignSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Campaign name is required'],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    steps: {
      type: [stepSchema],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // The contact import (CSV/XLSX batch) this campaign draws its enrollable
    // contacts from. Required for campaigns created after this feature; optional
    // on the schema so pre-existing campaigns keep loading safely.
    import: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Import',
    },
    // The allocation batch of that list this campaign is for
    // (Import.allocation.batches[]._id). When set, the campaign's audience is
    // EXACTLY that batch's persisted members (Contact.importBatch) — never the
    // whole list. Required when the list has batches; null on campaigns whose
    // list has none, which keep working on the whole list as before.
    batch: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

campaignSchema.index({ createdAt: -1 });

campaignSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Campaign', campaignSchema);
