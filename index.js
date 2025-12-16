const express = require('express')
const cors = require('cors')
require('dotenv').config()
const { MongoClient, ServerApiVersion } = require('mongodb')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
const admin = require('firebase-admin')
const port = process.env.PORT || 3000
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
  'utf-8'
)
const serviceAccount = JSON.parse(decoded)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const app = express()
// middleware
app.use(
  cors({
    origin: [[process.env.CLIENT_DOMAIN]],
    credentials: true,
    optionSuccessStatus: 200,
  })
)
app.use(express.json())

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1]
  console.log(token)
  if (!token) return res.status(401).send({ message: 'Unauthorized Access!' })
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    console.log(decoded)
    next()
  } catch (err) {
    console.log(err)
    return res.status(401).send({ message: 'Unauthorized Access!', err })
  }
}
// Create a MongoClient 
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
})
async function run() {
  try {
    const db = client.db('lessonsDB')
    const lessonsCollection = db.collection('lessons')
    const usersCollection = db.collection('users')
    const favoritesCollection = db.collection('favorites')

    // add lesson
    app.post('/lessons', async (req, res) => {
      const lessonData = req.body;
      lessonData.likes = [];

      // get author's lesson count
      const user = await usersCollection.findOne(
        { email: lessonData.authorEmail },
        { projection: { lessonCount: 1 } }
      );
      const currentCount = user?.lessonCount || 0;
      lessonData.authorLessonCount = currentCount + 1;

      // update lesson count in the userCollection
      const userQuery = { email: lessonData.authorEmail };
      const update = { $inc: { lessonCount: 1 } };
      await usersCollection.updateOne(userQuery, update);

      const result = await lessonsCollection.insertOne(lessonData)
      res.send(result);
    })

    // get lessons from db
    app.get('/lessons', async (req, res) => {
      const result = await lessonsCollection.find().toArray();
      res.send(result);
    })
    //Lesson details:  get a single lesson from db
    app.get('/lesson-details/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }
      const result = await lessonsCollection.findOne(query);
      res.send(result);
    })
    // Lesson details: like
    app.post('/lesson/:id/like', verifyJWT, async (req, res) => {
      const Id = req.params.id;
      const userEmail = req.body.userId;

      const lesson = await lessonsCollection.findOne({ _id: new ObjectId(id) });

      // Check if already liked
      const alreadyLiked = lesson.likes.includes(userEmail);

      if (alreadyLiked) {
        await lessonsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $pull: { likes: userEmail },
            $inc: { likesCount: -1 }
          }
        );
      }
      else {
        await lessonsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $push: { likes: userEmail },
            $inc: { likesCount: 1 }
          }
        );
      }

      // Get updated count
      const updatedLesson = await lessonsCollection.findOne(
        { _id: new ObjectId(id) },
        { projection: { likesCount: 1, likes: 1 } }
      );

      res.send({
        success: true,
        likesCount: updatedLesson.likesCount,
        userLiked: !alreadyLiked
      });
    });
    // my-lessons
    app.get('/my-lessons/:email', async (req, res) => {
      const email = req.params.email;
      // authorEmail:"user@b.com"
      const query = { authorEmail: email };

      const result = await lessonsCollection.find(query).toArray();
      res.send(result);
    })

    // delete my lesson
    app.delete('/my-lesson/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }

      const result = await lessonsCollection.deleteOne(query);
      res.send(result)
    })
    // update my lesson
    app.patch('/my-lesson/:id', async (req, res) => {
      const { title, description, category, emotionalTone, privacy, accessLevel, image } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }

      const update = {
        $set: {
          title: title,
          description: description,
          category: category,
          emotionalTone: emotionalTone,
          privacy: privacy,
          accessLevel: accessLevel,
          last_update_at: new Date()
        }
      }
      // if image exist
      if (req.body.image) {
        update.$set.image = req.body.image;
      }


      const result = await lessonsCollection.updateOne(query, update)
      res.send(result)
    })


    // ---------------------------------------------
    // Manage-users role: save or update user in db
    app.post('/user',verifyJWT, async (req, res) => {
      const userData = req.body;
      // add some extra info
      userData.isPremium = false;
      userData.lessonCount = 0;
      userData.created_at = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      userData.role = 'user'

      const query = { email: userData?.email };

      //find if the user already exist or not
      const alreadyExists = await usersCollection.findOne(query);


      // if exist--> update
      if (alreadyExists) {
        console.log('updating user info-->')
        const update = {
          $set: {
            last_loggedIn: new Date().toISOString
          }
        }
        const result = await usersCollection.updateOne(query, update)

        return res.send(result)
      }

      // if user does'nt exist -->save 
      console.log('saving user info ....')
      const result = await usersCollection.insertOne(userData);
      res.send(result);
    })

    // Manage user: get all user's for admin
    app.get('/users', verifyJWT, async (req, res) => {
      // admin email
      const adminEmail = req.tokenEmail;
      // give all user except admin
      const result = await usersCollection.find({ email: { $ne: adminEmail } }).toArray();
      res.send(result);
    })

    // delete user: manage user
    app.delete('/users/:email', async (req, res) => {
      const email = req.params.email;
      const query = { email }

      const result = await usersCollection.deleteOne(query);
      res.send(result)
    })
    // update role: manage user
    app.patch('/update-role', verifyJWT, async (req, res) => {
      const { email, role } = req.body;
      console.log(email, role)
      const update = {
        $set: { role }
      }
      // update role in the user collection
      const result = await usersCollection.updateOne({ email }, update)
      res.send(result)
    })

    // useRole hook: get a user's role by email
    app.get('/user/role', verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail })
      res.send({
        role: result?.role,
        isPremium: result?.isPremium
      })
    })

    // Author 
    //  Get author info
    app.get('/author/:email', async (req, res) => {
      const { email } = req.params;

      const author = await usersCollection.findOne(
        { email },
        { projection: { password: 0, _id: 0 } }
      );

      if (!author) {
        return res.status(404).send({});
      }

      res.send({
        name: author.name || author.displayName, // support both
        email: author.email,
        photoURL: author.image || author.photoURL, // FIXED
        isPremium: author.isPremium || false
      });
    });
    //  author's public lessons
    app.get('/lessons/author/:email', async (req, res) => {
      const { email } = req.params;

      const lessons = await lessonsCollection.find({
        authorEmail: email,
        privacy: "public"
      }).toArray();

      res.send(lessons);
    });

    // --------------------------------------------------------------------
    // favorites
    app.post('/favorites', async(req,res)=>{
      const favoritesData=req.body;
      console.log(favoritesData)
      const result=await favoritesCollection.insertOne(favoritesData)
      res.send(result);
    })
    // Send a ping 
    await client.db('admin').command({ ping: 1 })
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    )
  } finally {

  }
}
run().catch(console.dir)

app.get('/', (req, res) => {
  res.send('WisdomCell Server is Running....')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})