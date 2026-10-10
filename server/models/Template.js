// Message template model. Bodies may contain merge fields like {{first_name}}.
const mongoose = require('mongoose');

const templateSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Template name is required'],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    body: {
      type: String,
      required: [true, 'Template body is required'],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

templateSchema.index({ createdAt: -1 });

templateSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Template', templateSchema);
