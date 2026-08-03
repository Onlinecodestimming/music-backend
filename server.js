"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const multer = require("multer");
const crypto = require("crypto");
const { Pool } = require("pg");

const {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand
} = require("@aws-sdk/client-s3");


const app = express();

const PORT = process.env.PORT || 3000;


/*
ENV CHECK
*/

const required = [
    "DATABASE_URL",
    "R2_ENDPOINT",
    "R2_KEY",
    "R2_SECRET",
    "R2_BUCKET",
    "PUBLIC_R2_URL"
];


for(const env of required){

    if(!process.env[env]){

        console.log(
            "Missing environment variable:",
            env
        );

        process.exit(1);

    }

}



/*
DATABASE
*/

const db = new Pool({

    connectionString:
        process.env.DATABASE_URL,

    ssl:{
        rejectUnauthorized:false
    }

});




/*
R2
*/

const r2 = new S3Client({

    region:"auto",

    endpoint:
        process.env.R2_ENDPOINT,

    credentials:{

        accessKeyId:
            process.env.R2_KEY,

        secretAccessKey:
            process.env.R2_SECRET

    }

});





/*
UPLOAD
*/


const upload =
multer({

    storage:
        multer.memoryStorage(),

    limits:{

        fileSize:
            60 * 1024 * 1024

    }

});






/*
MIDDLEWARE
*/

app.use(
    helmet({
        crossOriginResourcePolicy:false
    })
);


app.use(
    compression()
);


app.use(
    cors({
        origin:"*"
    })
);


app.use(
    express.json()
);







/*
DATABASE SETUP
*/

async function setup(){

await db.query(`

CREATE TABLE IF NOT EXISTS tracks (

id UUID PRIMARY KEY,

title TEXT,

artist TEXT,

album TEXT,

artwork TEXT,

url TEXT,

filename TEXT,

size BIGINT,

created TIMESTAMP DEFAULT NOW()

)

`);

}







function checkAdmin(req,res,next){

const key =
req.headers["x-admin-key"];


if(
    process.env.ADMIN_KEY &&
    key !== process.env.ADMIN_KEY
){

return res.status(401).json({

error:"Invalid admin key"

});

}


next();


}









function r2Url(key){

return (

process.env.PUBLIC_R2_URL.replace(/\/$/,"")

+
"/"
+
key

);

}








async function uploadR2(
key,
buffer,
type
){


await r2.send(

new PutObjectCommand({

Bucket:
process.env.R2_BUCKET,

Key:key,

Body:buffer,

ContentType:type

})

);


return r2Url(key);


}







/*
HEALTH
*/


app.get("/health",async(req,res)=>{


try{

await db.query(
"SELECT 1"
);


res.json({

ok:true,

database:true,

storage:"r2"

});


}

catch(e){

res.status(500).json({

error:e.message

});

}


});









/*
GET LIBRARY
*/


app.get(
"/api/library",
async(req,res)=>{


const result =
await db.query(`

SELECT *

FROM tracks

ORDER BY created DESC

`);



res.json({

tracks:
result.rows.map(t=>({

id:t.id,

title:t.title,

artist:t.artist,

album:t.album,

artwork:t.artwork,

url:t.url,

filename:t.filename,

size:Number(t.size)

}))

});


});









/*
UPLOAD
*/


app.post(
"/upload",
checkAdmin,
upload.single("file"),

async(req,res)=>{


try{


if(!req.file){

return res.status(400).json({

error:"No file"

});

}



const id =
crypto.randomUUID();


const ext =
req.file.originalname
.split(".")
.pop();



const key =
`music/${id}.${ext}`;



const url =
await uploadR2(

key,

req.file.buffer,

req.file.mimetype

);




const track = {


id,


title:
req.body.title ||
req.file.originalname,


artist:
req.body.artist ||
"Unknown",


album:
req.body.album ||
"Singles",


artwork:
req.body.artwork ||
"",


url,


filename:
req.file.originalname,


size:
req.file.size


};





await db.query(

`

INSERT INTO tracks

(
id,
title,
artist,
album,
artwork,
url,
filename,
size
)

VALUES

($1,$2,$3,$4,$5,$6,$7,$8)

`,

[

track.id,

track.title,

track.artist,

track.album,

track.artwork,

track.url,

track.filename,

track.size

]


);





res.json({

ok:true,

track

});



}

catch(err){


console.error(err);


res.status(500).json({

error:
err.message

});


}


});









/*
START
*/


setup()

.then(()=>{


app.listen(PORT,()=>{


console.log(
"Musicfy running on",
PORT
);


});


})

.catch(err=>{


console.error(
"Startup failed",
err
);


process.exit(1);


});
