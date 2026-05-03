const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const fileupload = require("express-fileupload");
const expresslayouts = require('express-ejs-layouts');
var mongodb = require('mongodb')
var MongoClient = require('mongodb').MongoClient;
app.set('views',path.join(__dirname,'/views/'));
app.set('view engine','ejs')
app.set('layout','layouts/mainlayouts');

app.use(expresslayouts);
app.use(fileupload());
app.use(express.static(__dirname+"/public"));
app.use(express.urlencoded({extended:false}));

const port = process.env.PORT || 3000;
const dbName = process.env.MONGODB_DB_NAME || "book_reselling";
const url = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const uploadDir = path.join(__dirname, "public", "book_img");

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

var admin_detail_collection;
var customer_registration_collection;
var category_master_collection;
var book_detail_collection;

MongoClient.connect(url, function(err, client){
    if(err) {
        console.error("Database connection failed", err);
        process.exit(1);
    }

    const db = client.db(dbName);
    admin_detail_collection = db.collection("admin_detail");
    customer_registration_collection = db.collection("customer_registration");
    category_master_collection = db.collection("category_master");
    book_detail_collection = db.collection("book_detail");
    console.log("Database connected successfully");

    app.listen(port, function(){
        console.log(`Server started on port ${port}`);
    });
});


app.get("/",function(req,res){
    res.render("default/home");
})

app.get("/health", function(req, res) {
    res.status(200).send("OK");
})


app.get("/about",function(req,res){
    res.render("default/about")
})

app.get("/contact",function(req,res){
    res.render("default/contact")
})

app.get("/registration",function(req,res){
    res.render("default/registration")
})

app.get("/login",function(req,res){
    res.render("default/login")
})

app.post("/log_user",function(req,res){
    const {txtemail,txtpwd} = req.body;
    
    admin_detail_collection.findOne({email_id: txtemail,pwd: txtpwd},function(err,result){
        if(err) throw err;
        if(result === null)
        {
            customer_registration_collection.findOne({email_id: txtemail,pwd: txtpwd},function(err2,result2){
                if(err2) throw err2;
                if(result2 === null)
                {
                    res.write("<script> alert('Invalid Email Id Or Password'); window.location.href='/login'; </script>")
                }else{
                    res.write("<script> alert('Customer Login Successfully'); window.location.href='/login'; </script>")
                }
            })
            
        }else{
            res.write("<script> alert('Admin Login Successfully'); window.location.href='/admin_manage_cat'; </script>")
        }
    })
})

app.get("/logout",function(req,res){
    res.redirect("/");
})

app.post("/add_customer",function(req,res){
    const {txtname,txtadd,txtcity,txtmno,txtemail,txtpwd} = req.body;
    customer_registration_collection.findOne({email_id: txtemail},function(err,result){
        if(err) throw err;
        if(result === null)
        {
            let custid=0;
            
            customer_registration_collection.find().sort({customer_id: -1}).limit(1).toArray(function(err2,result2){
                if(err2) throw err2;
                if(result2.length == 0)
                {
                    cust_id=1;
                }
                else
                {
                    var row = JSON.parse(JSON.stringify(result2[0]))
                    cust_id = row.customer_id + 1
                }
                customer_registration_collection.insertOne({customer_id: cust_id,customer_name: txtname,address: txtadd,city: txtcity,mobile_no: txtmno,email_id: txtemail,pwd: txtpwd},function(err3,result3){
                    if(err3) throw err3;
                    res.write("<script> alert('Customer Registration Successfully'); window.location.href='/login'; </script>")                    
                })
            })
        }else{
            res.write("<script> alert('Email ID Already Exists'); window.location.href='/registration'; </script>")            
        }
    })
})

app.get("/admin_manage_cat",function(req,res){
    category_master_collection.find().toArray(function(err,result){
        res.render("admin/admin_manage_cat",{layout: "layouts/adminlayouts",catitems: result})
    })
})

app.post("/add_cat",function(req,res){
    const {txtcat}  = req.body;
    let catid=0;
    category_master_collection.find().sort({category_id: -1}).limit(1).toArray(function(err2,result2){
        if(err2) throw err2;
        if(result2.length == 0)
        {
            catid=1;
        }
        else
        {
            var row = JSON.parse(JSON.stringify(result2[0]))
            catid = row.category_id + 1
        }
        category_master_collection.insertOne({category_id: catid,category: txtcat},function(err3,result3){
            if(err3) throw err3;
            res.write("<script> alert('Category Saved Successfully'); window.location.href='/admin_manage_cat'; </script>")                    
        })
    })
})

app.get("/delete_category/:cid",function(req,res){
    let catid = parseInt(req.params.cid);
    category_master_collection.remove({category_id: catid},function(err,result){
        if(err) throw err;
        res.write("<script> alert('Category Deleted Successfully'); window.location.href='/admin_manage_cat'; </script>")                            
    })
})

app.get("/edit_category/:cid",function(req,res){
    let catid = parseInt(req.params.cid);
    category_master_collection.find({category_id: catid}).toArray(function(err,result){
        if(err) throw err;
        res.render("admin/admin_update_cat",{layout: "layouts/adminlayouts",catitems: result})
    })
})

app.post("/update_cat",function(req,res){
    const {txtcatid,txtcat} = req.body;
    category_master_collection.updateOne({category_id: parseInt(txtcatid)},{$set:{category: txtcat}},function(err,result){
        if(err) throw err;
        res.write("<script> alert('Category Updated Successfully'); window.location.href='/admin_manage_cat'; </script>")                                
    })
})

app.get("/admin_manage_book",function(req,res){
    category_master_collection.find().toArray(function(err,result){
        if(err) throw err;
        book_detail_collection.find().toArray(function(err2,result2){
            if(err2) throw err2;
            res.render("admin/admin_manage_book",{layout: "layouts/adminlayouts",catitems:result,bookitems: result2});
        })
    })
});


app.post("/add_book",function(req,res){
    const {txtname,selcat,txtdesc,txtprice} = req.body;
    
    if(!req.files || Object.keys(req.files).length ==0)
    {
        res.write("<script> alert('Please Select Book Image'); window.location.href='/admin_manage_book'; </script>")
    }else{
        let samplefile = req.files.txtimg;
        let bookid = 0;
        let fileName = Date.now()+".jpg";
        let tmp_path = "/book_img/"+fileName;
        let upload_path = path.join(uploadDir, fileName);
        book_detail_collection.find().sort({book_id: -1}).limit(1).toArray(function(err2,result2){
            if(err2) throw err2;
            if(result2.length == 0)
            {
                bookid=1;
            }
            else
            {
                var row = JSON.parse(JSON.stringify(result2[0]))
                bookid = row.book_id + 1
            }
            book_detail_collection.insertOne({book_id: bookid,book_name: txtname,category_id: parseInt(selcat),description: txtdesc,book_price: parseInt(txtprice),book_img: tmp_path},function(err3,result3){
                if(err3) throw err3;
                samplefile.mv(upload_path,function(err4,result4){
                    if(err4)
                    {
                        res.write("<script> alert('Error In Image Uploading'); window.location.href='/admin_manage_book'; </script>")                    
                    }
                    else{
                        res.write("<script> alert('Book Detail Saved Successfully'); window.location.href='/admin_manage_book'; </script>")                    
                    }
                })
                
            })
        })
    }
});


app.get("/delete_book/:bid",function(req,res){
    let bookid = parseInt(req.params.bid);
    book_detail_collection.remove({book_id: bookid},function(err,result){
        if(err) throw err;
        res.write("<script> alert('Book Detail Deleted Successfully'); window.location.href='/admin_manage_book'; </script>")                            
    })
})

app.get("/edit_book/:bid",function(req,res){
    let bookid = parseInt(req.params.bid);
    category_master_collection.find().toArray(function(err,result){
        if(err) throw err;
        book_detail_collection.find({book_id: bookid}).toArray(function(err2,result2){
            if(err2) throw err2;
            res.render("admin/admin_update_book",{layout: "layouts/adminlayouts",catitems:result,bookitems: result2});
        })
    })
})


app.post("/update_book",function(req,res){
    const {txtbid,txtname,txtdesc,selcat,txtprice} = req.body;
    
    if(!req.files || Object.keys(req.files).length ==0)
    {
        book_detail_collection.updateOne({book_id: parseInt(txtbid)},{$set: {book_name:txtname,category_id:parseInt(selcat),description:txtdesc,book_price: parseInt(txtprice)}},function(err1,result1){
            if(err1) throw err1;
            res.write("<script> alert('Book Detail Updated Successfully'); window.location.href='/admin_manage_book'; </script>")                                                    
        })
    }else{
        let samplefile = req.files.txtimg;
        
        let fileName = Date.now()+".jpg";
        let tmp_path = "/book_img/"+fileName;
        let upload_path = path.join(uploadDir, fileName);
        book_detail_collection.updateOne({book_id: parseInt(txtbid)},{$set: {book_name:txtname,category_id:parseInt(selcat),description:txtdesc,book_price: parseInt(txtprice),book_img: tmp_path}},function(err1,result1){
            if(err1) throw err1;
            samplefile.mv(upload_path,function(err2,result2){
                if(err2)                
                {
                    res.write("<script> alert('Error In Book Detail Updation'); window.location.href='/admin_manage_book'; </script>")                                                            
                }else{
                    res.write("<script> alert('Book Detail Updated Successfully'); window.location.href='/admin_manage_book'; </script>")                                                    
                }
            })
            
        })
    }
})
