const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const { MongoClient, ObjectId, ServerApiVersion } = require('mongodb');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_missing');
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: false,
    deprecationErrors: true,
  },
});

app.use(
  cors({
    origin: [process.env.CLIENT_URL || 'http://localhost:3000'],
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));

let db;
const id = (value) => new ObjectId(value);
const cleanUser = (user) => {
  if (!user) return null;
  const { password, ...safe } = user;
  return { ...safe, _id: user._id.toString() };
};
const tokenFor = (user) =>
  jwt.sign(
    { id: user._id.toString(), email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await db.collection('Donor').findOne({ _id: id(decoded.id) });
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: 'Unauthorized' });
  }
}

const allow =
  (...roles) =>
  (req, res, next) =>
    roles.includes(req.user.role)
      ? next()
      : res.status(403).json({ message: 'Forbidden' });

app.get('/', (req, res) => res.json({ ok: true, name: 'BloodLink API' }));

pp.post('/api/auth/register', async (req, res) => {
  const {
    email,
    password,
    confirm_password,
    name,
    avatar,
    bloodGroup,
    district,
    upazila,
  } = req.body;
  if (!email || !password || !name || !bloodGroup || !district || !upazila) {
    return res.status(400).json({ message: 'Missing required fields' });
  }
  if (password !== confirm_password)
    return res.status(400).json({ message: 'Passwords do not match' });
  const exists = await db
    .collection('Donor')
    .findOne({ email: email.toLowerCase() });
  if (exists)
    return res.status(409).json({ message: 'Email already registered' });
  const user = {
    email: email.toLowerCase(),
    password: await bcrypt.hash(password, 10),
    name,
    avatar,
    bloodGroup,
    district,
    upazila,
    role: 'donor',
    status: 'active',
    createdAt: new Date(),
  };
  const result = await db.collection('Donor').insertOne(user);
  user._id = result.insertedId;
  res.status(201).json({ user: cleanUser(user), token: tokenFor(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db
    .collection('Donor')
    .findOne({ email: String(email || '').toLowerCase() });
  if (!user || !(await bcrypt.compare(password || '', user.password))) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }
  res.json({ user: cleanUser(user), token: tokenFor(user) });
});

app.get('/api/auth/me', auth, (req, res) => res.json(cleanUser(req.user)));

async function start() {
  await client.connect();
  db = client.db(process.env.DB_NAME || 'Blood');
  await db.collection('Donor').createIndex({ email: 1 }, { unique: true });
  app.listen(port, () => console.log(`BloodLink API running on ${port}`));
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
