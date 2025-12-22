require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
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

const verifyJWT = async (req, res, next) => {
  try {
    const authHeader = req.headers?.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).send({ message: 'Unauthorized Access!' })
    }

    const token = authHeader.split(' ')[1]
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    next()
  } catch (err) {
    console.log(err)
    return res.status(401).send({ message: 'Unauthorized Access!' })
  }
}


// Create a MongoClient with a MongoClientOptions object to set the Stable API version
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

    // Role-based middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email })
      if (user?.role !== 'admin') {
        return res.status(403).send({ message: "Admin only Actions!", role: user?.role })
      }
    }

    // ---------------------------------------------------
    // add lesson
    app.post('/lessons', async (req, res) => {
      const lessonData = req.body;

      // manage lesson
      lessonData.likes = [];
      lessonData.isFeatured = false;
      lessonData.isReviewed = false;

      const user = await usersCollection.findOne(
        { email: lessonData.authorEmail },
        { projection: { lessonCount: 1 } }
      );
      const currentCount = user?.lessonCount || 0;
      lessonData.authorLessonCount = currentCount + 1;

      const userQuery = { email: lessonData.authorEmail };
      const update = { $inc: { lessonCount: 1 } };
      await usersCollection.updateOne(userQuery, update);

      const result = await lessonsCollection.insertOne(lessonData)
      res.send(result);
    });

    // All lesson:
    // get all lessons with search, filter, sort, pagination
    app.get('/lessons', async (req, res) => {
      try {
        const { limit = 0, skip = 0, category, emotionalTone, sortBy, search, admin, reportedOnly } = req.query;

        const query = {};

        //show ALL lessons (public + private)
        if (admin !== 'true') {
          query.privacy = 'public';
        }

        // Category filter
        if (category && category !== 'all') {
          query.category = category;
        }

        // Emotional tone filter
        if (emotionalTone && emotionalTone !== 'all') {
          query.emotionalTone = emotionalTone;
        }

        // Search by title
        if (search) {
          query.title = { $regex: search, $options: 'i' };
        }

        // Sorting
        let sortOption = {};
        if (sortBy === 'newest') {
          sortOption = { createdAt: -1 };
        } else if (sortBy === 'mostSaved') {
          sortOption = { favoritesCount: -1 };
        } else if (sortBy === 'title') {
          sortOption = { title: 1 };
        }

        // Get total count for current query
        const total = await lessonsCollection.countDocuments(query);

        // Get lessons
        const result = await lessonsCollection
          .find(query)
          .sort(sortOption)
          .limit(Number(limit))
          .skip(Number(skip))
          .toArray();

        // report
        let finalResult = result;
        if (reportedOnly === 'true') {
          const reports = await reportsCollection.find({}).toArray();
          const reportedLessonIds = reports.map(r => r.lessonId);

          finalResult = result.filter(lesson =>
            reportedLessonIds.includes(lesson._id.toString())
          );
        }

        // ONLY calculate stats when admin requests
        let stats = null;
        if (admin === 'true') {
          // Get ALL lessons for stats
          const allLessons = await lessonsCollection.find({}).toArray();

          // Get reports for reported count
          const reports = await reportsCollection.find({}).toArray();
          const reportedLessonIds = [...new Set(reports.map(r => r.lessonId))]; // Unique lesson IDs

          stats = {
            total: allLessons.length,
            public: allLessons.filter(l => l.privacy === 'public').length,
            private: allLessons.filter(l => l.privacy === 'private').length,
            reported: reportedLessonIds.length
          };
        }

        // Send response
        res.send({
          success: true,
          result: finalResult,
          total: total,
          stats
        });

      } catch (error) {
        console.error('Error fetching lessons:', error);
        res.status(500).send({ error: 'Server error' });
      }
    });

    //Lesson details:  get a single lesson from db
    app.get('/lesson-details/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }
      const result = await lessonsCollection.findOne(query);
      res.send(result);
    })

    // Lesson details: like
    app.post('/lesson/:id/like', verifyJWT, async (req, res) => {
      const id = req.params.id;
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
    // privacy to my-lesson
    app.patch('/lesson/:id/privacy', async (req, res) => {
      const { privacy } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }
      const update = {
        $set: { privacy }
      }
      const result = await lessonsCollection.updateOne(query, update);

      res.send(result);
    });
    //access level my-lesson
    app.patch('/lesson/:id/access', async (req, res) => {
      const { accessLevel } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }
      const update = {
        $set: { accessLevel }
      }
      const result = await lessonsCollection.updateOne(query, update);
      res.send(result);
    });
    // delete my lesson
    app.delete('/my-lesson/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }

      const lesson = await lessonsCollection.findOne(query);

      if (!lesson) {
        return res.status(404).send({ error: 'Lesson not found' });
      }
      const result = await lessonsCollection.deleteOne(query);

      await usersCollection.updateOne(
        { email: lesson.authorEmail },
        { $inc: { lessonCount: -1 } }
      );
      res.send(result)
    })
    // update my lesson
    app.patch('/my-lesson/:id', verifyJWT, async (req, res) => {
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
    
    app.get('/lessons/featured', async (req, res) => {
      const featuredLessons = await lessonsCollection.find({
        isFeatured: true,
        privacy: 'public'
      })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(featuredLessons);
    });


    // featured status
    app.patch('/lesson/:id/feature', verifyJWT, verifyAdmin, async (req, res) => {
      const lessonId = req.params.id;
      const { isFeatured } = req.body;

      const result = await lessonsCollection.updateOne(
        { _id: new ObjectId(lessonId) },
        { $set: { isFeatured: isFeatured } }
      );

      res.send({
        success: true,
        modifiedCount: result.modifiedCount
      });
    });

    // reviewed
    app.patch('/lesson/:id/reviewed', verifyJWT, verifyAdmin, async (req, res) => {
      const lessonId = req.params.id;

      const result = await lessonsCollection.updateOne(
        { _id: new ObjectId(lessonId) },
        {
          $set: {
            isReviewed: true,
            reviewedAt: new Date(),
          }
        }
      );

      res.send({
        success: true,
        modifiedCount: result.modifiedCount
      });
    });

    // ------------------------------------------------
    // extra section
    app.get('/top-contributors', async (req, res) => {
      const contributors = await usersCollection
        .find({ role: 'user' })
        .sort({ lessonCount: -1 }) // most lessons first
        .limit(3)
        .project({
          name: 1,
          email: 1,
          image: 1,
          lessonCount: 1
        })
        .toArray();

      res.send(contributors);
    });
    // most saved
    app.get('/most-saved-lessons', async (req, res) => {
      const result = await lessonsCollection
        .find({ privacy: 'public' })
        .sort({ favoritesCount: -1 })
        .limit(6)
        .toArray();

      res.send(result);
    })


    // ---------------------------------------------
    // Manage-users role: save or update user in db
    app.post('/user', async (req, res) => {
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

        // update
        const update = {
          $set: {
            last_loggedIn: new Date().toISOString(),
            update_at: new Date().toISOString(),
          }
        }
        // update name and img
        if (userData.name) {
          update.$set.name = userData.name;
        }
        if (userData.image) {
          update.$set.image = userData.image;
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
    app.delete('/users/:email', verifyJWT, verifyAdmin, async (req, res) => {
      const email = req.params.email;
      const query = { email }

      const result = await usersCollection.deleteOne(query);
      res.send(result)
    })
    // update role: manage user
    app.patch('/update-role', verifyJWT, verifyAdmin, async (req, res) => {
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

    // -------------------------------------------------------------
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
    app.post('/lesson/:id/favorite', async (req, res) => {

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
          title: title,
          accessLevel: accessLevel,
          category: category,
          emotionalTone: emotionalTone,
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
    app.get('/favorites/:email', async (req, res) => {
      const email = req.params.email;
      const query = { userEmail: email };

      const result = await favoritesCollection.find(query).toArray();
      res.send(result);
    })

    // delete my fav
    app.delete('/my-favorites/:id', async (req, res) => {
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


    // ---------------------------------------------------------------------------
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
    app.get('/reports', verifyJWT, async (req, res) => {
      const result = await reportsCollection.find().toArray();
      res.send(result);
    });
    // get 1 report lesson details
    app.get('/reports/:lessonId', verifyJWT, verifyAdmin, async (req, res) => {
      const lessonId = req.params.lessonId;

      const result = await reportsCollection.findOne({ lessonId });

      if (!result) return res.send({});

      res.send(result);
    });
    // delete report lesson
    app.delete('/reports/:lessonId', verifyJWT, verifyAdmin, async (req, res) => {
      const lessonId = req.params.lessonId;

      await lessonsCollection.deleteOne({ _id: new ObjectId(lessonId) });

      const result = await reportsCollection.deleteOne({ lessonId });

      res.send({ success: true, result });
    });
    // ignore
    app.patch('/reports/ignore/:lessonId', verifyJWT, verifyAdmin, async (req, res) => {
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
                name: "WisdomVault Premium"
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

    // Send a ping to confirm a successful connection
    // await client.db('admin').command({ ping: 1 })
    // console.log(
    //   'Pinged your deployment. You successfully connected to MongoDB!'
    // );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir)

app.get('/', (req, res) => {
  res.send('WisdomCell Server is Running....')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})
