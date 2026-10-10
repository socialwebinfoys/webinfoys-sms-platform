// User/Admin account model. Backs authentication for the platform's operators.
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },
    // Never returned by default queries; must be explicitly selected for login.
    password: {
      type: String,
      required: [true, 'Password is required'],
      // Phase 0: raised from 8 to 12. Only validated when the path is modified,
      // so existing accounts keep working — their stored hash is untouched and
      // comparePassword() does not run validation.
      minlength: [12, 'Password must be at least 12 characters'],
      select: false,
    },
    role: {
      type: String,
      enum: ['admin', 'user'],
      default: 'user',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Hash the password whenever it is set or changed, so plaintext never touches
// the database. Async middleware resolves via the returned promise.
userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  this.password = await bcrypt.hash(this.password, salt);
});

// Compare a plaintext candidate against the stored hash.
userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

// Strip sensitive fields from any JSON representation sent to clients.
userSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
