"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const mime = require("mime-types");
const { v4: uuid } = require("uuid");

const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand
} = require("@aws-sdk/client-s3");

const { Upload } = require("@aws-sdk/lib-storage");

const mm = require("music-metadata");

const app = express();

const PORT = process.env.PORT || 3000;

const ADMIN_KEY = process.env.ADMIN_KEY;

const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL.replace(/\/$/, "");

const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 60 * 1024 * 1024
    }
});

app.use(helmet({
    crossOriginResourcePolicy: {
        policy: "cross-origin"
    }
}));

app.use(compression());

app.use(cors({
    origin: "*"
}));

app.use(express.json());

function auth(req, res, next){

    if(!ADMIN_KEY)
        return next();

    if(req.headers["x-admin-key"] !== ADMIN_KEY){

        return res.status(401).json({
            error:"Unauthorized"
        });

    }

    next();

}

async function streamToBuffer(stream){

    const chunks=[];

    for await(const chunk of stream)
        chunks.push(chunk);

    return Buffer.concat(chunks);

}

async function getLibrary(){

    try{

        const obj=await s3.send(new GetObjectCommand({
            Bucket:R2_BUCKET,
            Key:"library.json"
        }));

        const txt=(await streamToBuffer(obj.Body)).toString();

        return JSON.parse(txt);

    }

    catch{

        return{
            tracks:[]
        };

    }

}

async function saveLibrary(library){

    await s3.send(new PutObjectCommand({

        Bucket:R2_BUCKET,

        Key:"library.json",

        Body:JSON.stringify(library,null,2),

        ContentType:"application/json"

    }));

}

function publicUrl(key){

    return `${R2_PUBLIC_URL}/${key}`;

}

async function uploadBuffer(buffer,key,type){

    await new Upload({

        client:s3,

        params:{

            Bucket:R2_BUCKET,

            Key:key,

            Body:buffer,

            ContentType:type,

            CacheControl:"public,max-age=31536000"

        }

    }).done();

    return publicUrl(key);

}

async function deleteObject(key){

    if(!key)
        return;

    await s3.send(new DeleteObjectCommand({

        Bucket:R2_BUCKET,

        Key:key

    }));

}

async function extractMetadata(file){

    try{

        return await mm.parseBuffer(
            file.buffer,
            {
                mimeType:file.mimetype
            },
            {
                duration:true
            }
        );

    }

    catch{

        return{

            common:{},

            format:{}

        };

    }

}
app.get("/health",(req,res)=>{

    res.json({
        ok:true,
        storage:"Cloudflare R2"
    });

});

app.get("/api/library",async(req,res)=>{

    const library=await getLibrary();

    const q=(req.query.q||"").toLowerCase().trim();

    if(!q)
        return res.json(library);

    const tracks=library.tracks.filter(track=>{

        return(
            track.title.toLowerCase().includes(q)||
            track.artist.toLowerCase().includes(q)||
            track.album.toLowerCase().includes(q)
        );

    });

    res.json({tracks});

});

app.post(
    "/upload",
    auth,
    upload.single("file"),
    async(req,res)=>{

        if(!req.file){

            return res.status(400).json({
                error:"No file uploaded."
            });

        }

        const metadata=await extractMetadata(req.file);

        const id=uuid();

        const ext=
            path.extname(req.file.originalname)||
            "."+mime.extension(req.file.mimetype);

        const audioKey=`music/${id}${ext}`;

        const audioUrl=await uploadBuffer(

            req.file.buffer,

            audioKey,

            req.file.mimetype

        );

        let artwork="";
        let artworkKey="";

        const picture=metadata.common.picture?.[0];

        if(picture){

            const imgExt=

                picture.format==="image/png"
                ?".png"

                :picture.format==="image/webp"
                ?".webp"

                :".jpg";

            artworkKey=`artwork/${id}${imgExt}`;

            artwork=await uploadBuffer(

                picture.data,

                artworkKey,

                picture.format

            );

        }

        else if(req.body.artwork){

            artwork=req.body.artwork.trim();

        }

        const track={

            id,

            title:
                req.body.title?.trim()||
                metadata.common.title||
                path.parse(req.file.originalname).name,

            artist:
                req.body.artist?.trim()||
                metadata.common.artist||
                metadata.common.albumartist||
                "Unknown Artist",

            album:
                req.body.album?.trim()||
                metadata.common.album||
                "Singles",

            artwork,

            artworkKey,

            url:audioUrl,

            objectKey:audioKey,

            filename:req.file.originalname,

            mime:req.file.mimetype,

            size:req.file.size,

            duration:
                metadata.format.duration||0,

            uploadedAt:
                new Date().toISOString()

        };

        const library=await getLibrary();

        library.tracks.push(track);

        await saveLibrary(library);

        res.status(201).json({

            ok:true,

            track

        });

    }

);

app.patch(
    "/api/tracks/:id",
    auth,
    async(req,res)=>{

        const library=await getLibrary();

        const track=library.tracks.find(

            t=>t.id===req.params.id

        );

        if(!track){

            return res.status(404).json({

                error:"Track not found."

            });

        }

        if(req.body.title!==undefined)
            track.title=req.body.title.trim();

        if(req.body.artist!==undefined)
            track.artist=req.body.artist.trim();

        if(req.body.album!==undefined)
            track.album=req.body.album.trim();

        if(req.body.artwork!==undefined)
            track.artwork=req.body.artwork.trim();

        await saveLibrary(library);

        res.json({

            ok:true,

            track

        });

    }

);
app.delete(
    "/api/tracks/:id",
    auth,
    async(req,res)=>{

        const library=await getLibrary();

        const index=library.tracks.findIndex(
            t=>t.id===req.params.id
        );

        if(index===-1){

            return res.status(404).json({
                error:"Track not found."
            });

        }

        const track=library.tracks[index];

        try{

            await deleteObject(track.objectKey);

            if(track.artworkKey)
                await deleteObject(track.artworkKey);

        }
        catch(err){

            console.error("R2 delete failed:",err);

        }

        library.tracks.splice(index,1);

        await saveLibrary(library);

        res.json({
            ok:true
        });

    }
);

app.use((req,res)=>{

    res.status(404).json({
        error:"Route not found."
    });

});

app.use((err,req,res,next)=>{

    console.error(err);

    if(err instanceof multer.MulterError){

        return res.status(400).json({

            error:
                err.code==="LIMIT_FILE_SIZE"
                    ?"Maximum file size is 60MB."
                    :err.message

        });

    }

    res.status(500).json({

        error:
            err.message||
            "Internal Server Error"

    });

});

app.listen(PORT,()=>{

    console.log("");

    console.log("====================================");

    console.log(" Musicfy Backend Started");

    console.log("====================================");

    console.log(`Port: ${PORT}`);

    console.log(`Bucket: ${R2_BUCKET}`);

    console.log(`Public URL: ${R2_PUBLIC_URL}`);

    console.log("");

});
