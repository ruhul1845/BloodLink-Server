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

app.patch('/api/users/me', auth, async (req, res) => {
  const allowed = ['name', 'avatar', 'bloodGroup', 'district', 'upazila'];
  const update = {};
  allowed.forEach((key) => {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  });
  await db
    .collection('Donor')
    .updateOne(
      { _id: req.user._id },
      { $set: { ...update, updatedAt: new Date() } }
    );
  const user = await db.collection('Donor').findOne({ _id: req.user._id });
  res.json(cleanUser(user));
});

app.get('/api/users', auth, allow('admin'), async (req, res) => {
  const query = req.query.status ? { status: req.query.status } : {};
  const users = await db
    .collection('Donor')
    .find(query)
    .sort({ createdAt: -1 })
    .toArray();
  res.json(users.map(cleanUser));
});

app.patch(
  '/api/users/:userId/status',
  auth,
  allow('admin'),
  async (req, res) => {
    if (!['active', 'blocked'].includes(req.body.status))
      return res.status(400).json({ message: 'Invalid status' });
    await db
      .collection('Donor')
      .updateOne(
        { _id: id(req.params.userId) },
        { $set: { status: req.body.status } }
      );
    res.json({ modified: true });
  }
);

app.patch('/api/users/:userId/role', auth, allow('admin'), async (req, res) => {
  if (!['donor', 'volunteer', 'admin'].includes(req.body.role))
    return res.status(400).json({ message: 'Invalid role' });
  await db
    .collection('Donor')
    .updateOne(
      { _id: id(req.params.userId) },
      { $set: { role: req.body.role } }
    );
  res.json({ modified: true });
});

app.get('/api/donors/search', async (req, res) => {
  const { bloodGroup, district, upazila } = req.query;
  if (!bloodGroup || !district || !upazila) return res.json([]);
  const users = await db
    .collection('Donor')
    .find({ role: 'donor', status: 'active', bloodGroup, district, upazila })
    .toArray();
  res.json(users.map(cleanUser));
});

app.get('/api/requests', async (req, res) => {
  const requests = await db
    .collection('donationRequests')
    .find({ status: 'pending' })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(requests);
});

app.post('/api/requests', auth, async (req, res) => {
  if (req.user.status === 'blocked')
    return res
      .status(403)
      .json({ message: 'Blocked users cannot create requests' });
  const request = {
    requesterId: req.user._id.toString(),
    requesterName: req.user.name,
    requesterEmail: req.user.email,
    recipientName: req.body.recipientName,
    recipientDistrict: req.body.recipientDistrict,
    recipientUpazila: req.body.recipientUpazila,
    hospitalName: req.body.hospitalName,
    address: req.body.address,
    bloodGroup: req.body.bloodGroup,
    donationDate: req.body.donationDate,
    donationTime: req.body.donationTime,
    message: req.body.message,
    status: 'pending',
    createdAt: new Date(),
  };
  const result = await db.collection('donationRequests').insertOne(request);
  res.status(201).json({ ...request, _id: result.insertedId });
});

app.get('/api/requests/my', auth, async (req, res) => {
  const query = { requesterId: req.user._id.toString() };
  if (req.query.status) query.status = req.query.status;
  const rows = await db
    .collection('donationRequests')
    .find(query)
    .sort({ createdAt: -1 })
    .toArray();
  res.json(rows);
});

app.get(
  '/api/requests/all',
  auth,
  allow('admin', 'volunteer'),
  async (req, res) => {
    const query = req.query.status ? { status: req.query.status } : {};
    const rows = await db
      .collection('donationRequests')
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();
    res.json(rows);
  }
);

app.get('/api/requests/:requestId', auth, async (req, res) => {
  const request = await db
    .collection('donationRequests')
    .findOne({ _id: id(req.params.requestId) });
  if (!request) return res.status(404).json({ message: 'Request not found' });
  res.json(request);
});

app.patch('/api/requests/:requestId', auth, async (req, res) => {
  const request = await db
    .collection('donationRequests')
    .findOne({ _id: id(req.params.requestId) });
  if (!request) return res.status(404).json({ message: 'Request not found' });
  const owner = request.requesterId === req.user._id.toString();
  const canEditAll = req.user.role === 'admin';
  const volunteerStatusOnly = req.user.role === 'volunteer';
  if (!owner && !canEditAll && !volunteerStatusOnly)
    return res.status(403).json({ message: 'Forbidden' });
  const writable = [
    'recipientName',
    'recipientDistrict',
    'recipientUpazila',
    'hospitalName',
    'address',
    'bloodGroup',
    'donationDate',
    'donationTime',
    'message',
  ];
  const update = {};
  if (!volunteerStatusOnly)
    writable.forEach(
      (key) => req.body[key] !== undefined && (update[key] = req.body[key])
    );
  if (
    req.body.status &&
    ['pending', 'inprogress', 'done', 'canceled'].includes(req.body.status)
  )
    update.status = req.body.status;
  await db
    .collection('donationRequests')
    .updateOne(
      { _id: request._id },
      { $set: { ...update, updatedAt: new Date() } }
    );
  res.json({ modified: true });
});

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
