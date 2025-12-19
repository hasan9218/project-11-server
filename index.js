const express = require('express')
const cors = require('cors')
require('dotenv').config()
const { MongoClient, ServerApiVersion } = require('mongodb')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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
    origin: process.env.CLIENT_DOMAIN,
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
    const commentsCollection = db.collection('comments')
    const reportsCollection = db.collection('reports')
    const paymentsCollection = db.collection('payments')

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
      const userEmail = req.body.userEmail;

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
    // Similar lesson
    app.get('/lessons/similar', async (req, res) => {
      const { category, emotionalTone, lessonId } = req.query;

      if (!category && !emotionalTone) {
        return res.send([]);
      }

      const query = {
        _id: { $ne: new ObjectId(lessonId) },
        privacy: 'public',
        $or: [
          { category: category },
          { emotionalTone: emotionalTone }
        ]
      };

      const result = await lessonsCollection
        .find(query)
        .limit(6)
        .toArray();

      res.send(result);
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
    app.post('/user', verifyJWT, async (req, res) => {
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
    app.post('/lesson/:id/favorite', verifyJWT, async (req, res) => {

      const { lessonId, userEmail, title, accessLevel, category, emotionalTone } = req.body;

      // check if already saved 
      const existing = await favoritesCollection.findOne({
        lessonId: lessonId,
        userEmail: userEmail
      });

      // if exist,delete
      if (existing) {
        await favoritesCollection.deleteOne({
          lessonId: lessonId,
          userEmail: userEmail
        });

        await lessonsCollection.updateOne(
          { _id: new ObjectId(lessonId) },
          { $inc: { favoritesCount: -1 } }
        );
      } 
      else {
        // if not,add
        await favoritesCollection.insertOne({
          lessonId: lessonId,
          userEmail: userEmail,
          title:title, 
          accessLevel:accessLevel, 
          category:category, 
          emotionalTone:emotionalTone,
          saved_at: new Date().toISOString()
        });

        await lessonsCollection.updateOne(
          { _id: new ObjectId(lessonId) },
          { $inc: { favoritesCount: 1 } }
        );
      }
      const updatedLesson = await lessonsCollection.findOne(
        { _id: new ObjectId(lessonId) },
        { projection: { favoritesCount: 1 } }
      );

      const favoritesCount = updatedLesson.favoritesCount || 0;

      res.send({
        success: true,
        favoritesCount: favoritesCount,
        userFavorited: !existing
      });
    });
    // my favorites
     app.get('/favorites/:email', verifyJWT, async (req, res) => {
      const email = req.params.email;
      const query = { userEmail: email };

      const result = await favoritesCollection.find(query).toArray();
      res.send(result);
    })

    // delete my fav
    app.delete('/my-favorites/:id', verifyJWT, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }
      
      //get lesson id
      const favorite = await favoritesCollection.findOne(query);
      if (!favorite) {
        return res.status(404).send({
          message: 'Favorite not found'
        });
      }
      const lessonId = favorite.lessonId;
      // delete
      const result = await favoritesCollection.deleteOne(query);
      // update lesson
      await lessonsCollection.updateOne(
        { _id: new ObjectId(lessonId) },
        { $inc: { favoritesCount: -1 } }
      );

      res.send(result)
    })
    // comments
    app.post('/comments', async (req, res) => {
      const commentData = req.body;

      const result = await commentsCollection.insertOne(commentData);
      res.send(result);
    })
     app.get('/comments/:id', async (req, res) => {
      const id = req.params.id;
      const query = { lessonId: id }

      const result = await commentsCollection.find(query).toArray();
      res.send(result)
    })

    // -----------------------------------------------------------------------------
    // Report
    // add report lesson
    app.post('/reports', async (req, res) => {
      const { lessonId, lessonTitle, reporterEmail, reporterName, reason } = req.body;

      if (!lessonId || !reporterEmail || !reporterName || !reason) {
        return res.status(400).send({ message: "Missing fields" });
      }

      const query = { lessonId: lessonId };
      const existing = await reportsCollection.findOne(query);

      const reportEntry = {
        reporterEmail,
        reporterName,
        reason,
        reportedAt: new Date()
      };

      if (existing) {
        // Update existing with $push
        const updateDoc = {
          $inc: { totalReports: 1 },
          $push: { reportReasons: reportEntry }
        };

        await reportsCollection.updateOne(query, updateDoc);

        return res.send({ message: "Report added to existing lesson" });
      }

      // Create new reported lesson
      const newReport = {
        lessonId,
        lessonTitle,
        totalReports: 1,
        reportReasons: [reportEntry]
      };

      const result = await reportsCollection.insertOne(newReport);

      res.send(result);
    });
    // get all report lesson
    app.get('/reports', async (req, res) => {
      const result = await reportsCollection.find().toArray();
      res.send(result);
    });
    // get 1 report lesson details
    app.get('/reports/:lessonId', async (req, res) => {
      const lessonId = req.params.lessonId;

      const result = await reportsCollection.findOne({ lessonId });

      if (!result) return res.send({});

      res.send(result);
    });
    // delete report lesson
    app.delete('/reports/:lessonId', async (req, res) => {
      const lessonId = req.params.lessonId;

      await lessonsCollection.deleteOne({ _id: new ObjectId(lessonId) });

      const result = await reportsCollection.deleteOne({ lessonId });

      res.send({ success: true, result });
    });

    // ignore
    app.patch('/reports/ignore/:lessonId', async (req, res) => {
      const lessonId = req.params.lessonId;

      const result = await reportsCollection.deleteOne({ lessonId });

      res.send({ success: true, message: "Report ignored & removed", result });
    });

    // ------------------------------------------------------------------------------------------
    // Payments endpoints
    app.post('/create-checkout-session', async (req, res) => {
      const paymentInfo = req.body;
      console.log(paymentInfo);

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: "WisdomCell Premium"
              },
              unit_amount: paymentInfo?.price * 100,
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo?.userEmail,
        // extra info
        metadata: {
          userEmail: paymentInfo?.userEmail,
          userName: paymentInfo?.userName,
        },
        mode: 'payment',
        // if payment success
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        // if payment cancel
        cancel_url: `${process.env.CLIENT_DOMAIN}/payment-cancel`
      })

      res.send({
        url: session.url
      })
    })

    // payment-success + session id
    app.post('/payment-success', async (req, res) => {
      const { sessionId } = req.body;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      const transactionId = session.payment_intent;
      const userEmail = session.metadata.userEmail;
      const userName = session.metadata.userName;

      // Check if user exists
      const user = await usersCollection.findOne({ email: userEmail });

      // payment complete or not
      if (session.payment_status !== 'paid') {
        return res.status(400).send({ message: "Payment not completed" });
      }

      // already paid or not
      const existingPayment = await paymentsCollection.findOne({
        transactionId
      });

      if (existingPayment) {
        return res.send({
          message: "Payment already processed",
          transactionId,
        });
      }

      // Save payment info
      const paymentInfo = {
        transactionId,
        userEmail,
        userName,
        amount: session.amount_total / 100,
        currency: session.currency,
        paidAt: new Date(),
      };

      const paymentResult = await paymentsCollection.insertOne(paymentInfo);

      // Update user to Premium
      await usersCollection.updateOne(
        { email: userEmail },
        {
          $set: {
            isPremium: true,
            premiumSince: new Date(),
          },
        }
      );

      res.send({
        success: true,
        transactionId,
        paymentId: paymentResult.insertedId,
      });
    });
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
  res.send('WisdomCell Server is Run')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})