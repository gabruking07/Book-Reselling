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
var customer_details_collection;
var category_master_collection;
var book_detail_collection;
var order_detail_collection;
let currentCustomer = null;
let currentAdmin = null;

app.use(function(req, res, next) {
    res.locals.currentCustomer = currentCustomer;
    res.locals.currentAdmin = currentAdmin;
    next();
});

function ensureCustomer(res) {
    if (!currentCustomer) {
        res.send("<script> alert('Please login as customer first'); window.location.href='/login'; </script>");
        return false;
    }
    return true;
}

function ensureAdmin(res) {
    if (!currentAdmin) {
        res.send("<script> alert('Please login as admin first'); window.location.href='/login'; </script>");
        return false;
    }
    return true;
}

MongoClient.connect(url, function(err, client){
    if(err) {
        console.error("Database connection failed", err);
        process.exit(1);
    }

    const db = client.db(dbName);
    admin_detail_collection = db.collection("admin_detail");
    customer_details_collection = db.collection("customer_details");
    category_master_collection = db.collection("category_master");
    book_detail_collection = db.collection("book_detail");
    order_detail_collection = db.collection("order_detail");
    console.log("Database connected successfully");

    if (!process.env.VERCEL) {
        app.listen(port, function(){
            console.log(`Server started on port ${port}`);
        });
    }
});

module.exports = app;


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

app.get("/admin_registration", function(req, res) {
    res.redirect("/registration");
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
            customer_details_collection.findOne({email_id: txtemail,pwd: txtpwd},function(err2,result2){
                if(err2) throw err2;
                if(result2 === null)
                {
                    res.send("<script> alert('Invalid Email Id Or Password'); window.location.href='/login'; </script>")
                }else{
                    currentCustomer = result2;
                    currentAdmin = null;
                    res.send("<script> alert('Customer Login Successfully'); window.location.href='/books'; </script>")
                }
            })
            
        }else{
            currentAdmin = result;
            currentCustomer = null;
            res.send("<script> alert('Admin Login Successfully'); window.location.href='/admin_manage_cat'; </script>")
        }
    })
})

app.get("/logout",function(req,res){
    currentCustomer = null;
    currentAdmin = null;
    res.redirect("/");
})

app.post("/add_customer",function(req,res){
    const {txtname,txtadd,txtcity,txtmno,txtemail,txtpwd} = req.body;
    customer_details_collection.findOne({email_id: txtemail},function(err,result){
        if(err) throw err;
        if(result === null)
        {
            let cust_id = 0;
            
            customer_details_collection.find().sort({customer_id: -1}).limit(1).toArray(function(err2,result2){
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
                customer_details_collection.insertOne({customer_id: cust_id,customer_name: txtname,address: txtadd,city: txtcity,mobile_no: txtmno,email_id: txtemail,pwd: txtpwd},function(err3,result3){
                    if(err3) throw err3;
                    res.send("<script> alert('Customer Registration Successfully'); window.location.href='/login'; </script>")                    
                })
            })
        }else{
            res.send("<script> alert('Email ID Already Exists'); window.location.href='/registration'; </script>")            
        }
    })
})

app.post("/add_admin", function(req, res) {
    const {txtname, txtemail, txtpwd} = req.body;

    admin_detail_collection.findOne({email_id: txtemail}, function(err, result) {
        if (err) throw err;

        if (result !== null) {
            res.send("<script> alert('Admin Email ID Already Exists'); window.location.href='/registration'; </script>");
            return;
        }

        admin_detail_collection.find().sort({admin_id: -1}).limit(1).toArray(function(err2, result2) {
            if (err2) throw err2;

            let adminId = 1;
            if (result2.length !== 0) {
                adminId = result2[0].admin_id + 1;
            }

            admin_detail_collection.insertOne({
                admin_id: adminId,
                admin_name: txtname,
                email_id: txtemail,
                pwd: txtpwd
            }, function(err3) {
                if (err3) throw err3;
                res.send("<script> alert('Admin Registration Successfully'); window.location.href='/login'; </script>");
            });
        });
    });
});

app.get("/books", function(req, res) {
    category_master_collection.find().toArray(function(err, categories) {
        if (err) throw err;

        book_detail_collection.find().toArray(function(err2, books) {
            if (err2) throw err2;

            const booksWithCategory = books.map(function(book) {
                const category = categories.find(function(item) {
                    return item.category_id === book.category_id;
                });

                return {
                    ...book,
                    category_name: category ? category.category : "Unknown"
                };
            });

            res.render("default/view_books", {
                categories: categories,
                bookitems: booksWithCategory
            });
        });
    });
});

app.get("/buy_book/:bid", function(req, res) {
    if (!ensureCustomer(res)) {
        return;
    }

    const bookid = parseInt(req.params.bid);

    category_master_collection.find().toArray(function(err, categories) {
        if (err) throw err;

        book_detail_collection.findOne({book_id: bookid}, function(err2, book) {
            if (err2) throw err2;

            if (!book) {
                res.send("<script> alert('Book not found'); window.location.href='/books'; </script>");
                return;
            }

            const category = categories.find(function(item) {
                return item.category_id === book.category_id;
            });

            res.render("default/buy_book", {
                bookitem: {
                    ...book,
                    category_name: category ? category.category : "Unknown"
                }
            });
        });
    });
});

app.post("/place_order", function(req, res) {
    if (!ensureCustomer(res)) {
        return;
    }

    const {txtbid, txtqty} = req.body;
    const quantity = parseInt(txtqty);
    const bookid = parseInt(txtbid);

    if (!quantity || quantity < 1) {
        res.send("<script> alert('Please enter valid quantity'); window.location.href='/books'; </script>");
        return;
    }

    category_master_collection.find().toArray(function(err, categories) {
        if (err) throw err;

        book_detail_collection.findOne({book_id: bookid}, function(err2, book) {
            if (err2) throw err2;

            if (!book) {
                res.send("<script> alert('Book not found'); window.location.href='/books'; </script>");
                return;
            }

            order_detail_collection.find().sort({order_id: -1}).limit(1).toArray(function(err3, result3) {
                if (err3) throw err3;

                let orderId = 1;
                if (result3.length !== 0) {
                    orderId = result3[0].order_id + 1;
                }

                const category = categories.find(function(item) {
                    return item.category_id === book.category_id;
                });

                const totalAmount = quantity * parseInt(book.book_price);

                order_detail_collection.insertOne({
                    order_id: orderId,
                    customer_id: currentCustomer.customer_id,
                    customer_name: currentCustomer.customer_name,
                    email_id: currentCustomer.email_id,
                    address: currentCustomer.address,
                    city: currentCustomer.city,
                    mobile_no: currentCustomer.mobile_no,
                    book_id: book.book_id,
                    book_name: book.book_name,
                    category_name: category ? category.category : "Unknown",
                    book_img: book.book_img,
                    book_price: parseInt(book.book_price),
                    quantity: quantity,
                    total_amount: totalAmount,
                    order_date: new Date().toLocaleDateString("en-GB"),
                    status: "Placed"
                }, function(err4) {
                    if (err4) throw err4;
                    res.send("<script> alert('Order placed successfully'); window.location.href='/my_orders'; </script>");
                });
            });
        });
    });
});

app.get("/my_orders", function(req, res) {
    if (!ensureCustomer(res)) {
        return;
    }

    order_detail_collection.find({customer_id: currentCustomer.customer_id}).sort({order_id: -1}).toArray(function(err, orders) {
        if (err) throw err;

        res.render("default/my_orders", {
            orderitems: orders
        });
    });
});

app.get("/admin_manage_cat",function(req,res){
    if (!ensureAdmin(res)) {
        return;
    }
    category_master_collection.find().toArray(function(err,result){
        res.render("admin/admin_manage_cat",{layout: "layouts/adminlayouts",catitems: result})
    })
})

app.post("/add_cat",function(req,res){
    if (!ensureAdmin(res)) {
        return;
    }
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
            res.send("<script> alert('Category Saved Successfully'); window.location.href='/admin_manage_cat'; </script>")                    
        })
    })
})

app.get("/delete_category/:cid",function(req,res){
    if (!ensureAdmin(res)) {
        return;
    }
    let catid = parseInt(req.params.cid);
    category_master_collection.remove({category_id: catid},function(err,result){
        if(err) throw err;
        res.send("<script> alert('Category Deleted Successfully'); window.location.href='/admin_manage_cat'; </script>")                            
    })
})

app.get("/edit_category/:cid",function(req,res){
    if (!ensureAdmin(res)) {
        return;
    }
    let catid = parseInt(req.params.cid);
    category_master_collection.find({category_id: catid}).toArray(function(err,result){
        if(err) throw err;
        res.render("admin/admin_update_cat",{layout: "layouts/adminlayouts",catitems: result})
    })
})

app.post("/update_cat",function(req,res){
    if (!ensureAdmin(res)) {
        return;
    }
    const {txtcatid,txtcat} = req.body;
    category_master_collection.updateOne({category_id: parseInt(txtcatid)},{$set:{category: txtcat}},function(err,result){
        if(err) throw err;
        res.send("<script> alert('Category Updated Successfully'); window.location.href='/admin_manage_cat'; </script>")                                
    })
})

app.get("/admin_manage_book",function(req,res){
    if (!ensureAdmin(res)) {
        return;
    }
    category_master_collection.find().toArray(function(err,result){
        if(err) throw err;
        book_detail_collection.find().toArray(function(err2,result2){
            if(err2) throw err2;
            res.render("admin/admin_manage_book",{layout: "layouts/adminlayouts",catitems:result,bookitems: result2});
        })
    })
});

app.get("/admin_reports", function(req, res) {
    if (!ensureAdmin(res)) {
        return;
    }
    category_master_collection.find().toArray(function(err, categories) {
        if (err) throw err;

        book_detail_collection.find().toArray(function(err2, books) {
            if (err2) throw err2;

            customer_details_collection.find().toArray(function(err3, customers) {
                if (err3) throw err3;
                order_detail_collection.find().toArray(function(err4, orders) {
                    if (err4) throw err4;

                    const booksWithCategory = books.map(function(book) {
                        const category = categories.find(function(item) {
                            return item.category_id === book.category_id;
                        });

                        return {
                            ...book,
                            category_name: category ? category.category : "Unknown"
                        };
                    });

                    res.render("admin/admin_reports", {
                        layout: "layouts/adminlayouts",
                        totalCategories: categories.length,
                        totalBooks: books.length,
                        totalCustomers: customers.length,
                        totalOrders: orders.length,
                        reportBooks: booksWithCategory,
                        reportCustomers: customers,
                        reportOrders: orders
                    });
                });
            });
        });
    });
});

app.get("/admin_orders", function(req, res) {
    if (!ensureAdmin(res)) {
        return;
    }

    order_detail_collection.find().sort({order_id: -1}).toArray(function(err, orders) {
        if (err) throw err;

        res.render("admin/admin_orders", {
            layout: "layouts/adminlayouts",
            orderitems: orders
        });
    });
});

app.get("/admin_bill/:oid", function(req, res) {
    if (!ensureAdmin(res)) {
        return;
    }

    const orderId = parseInt(req.params.oid);

    order_detail_collection.findOne({order_id: orderId}, function(err, order) {
        if (err) throw err;

        if (!order) {
            res.send("<script> alert('Order not found'); window.location.href='/admin_orders'; </script>");
            return;
        }

        res.render("admin/admin_bill", {
            layout: "layouts/adminlayouts",
            orderitem: order
        });
    });
});


app.post("/add_book",function(req,res){
    if (!ensureAdmin(res)) {
        return;
    }
    const {txtname,selcat,txtdesc,txtprice} = req.body;
    
    if(!req.files || Object.keys(req.files).length ==0)
    {
        res.send("<script> alert('Please Select Book Image'); window.location.href='/admin_manage_book'; </script>")
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
                        res.send("<script> alert('Error In Image Uploading'); window.location.href='/admin_manage_book'; </script>")                    
                    }
                    else{
                        res.send("<script> alert('Book Detail Saved Successfully'); window.location.href='/admin_manage_book'; </script>")                    
                    }
                })
                
            })
        })
    }
});


app.get("/delete_book/:bid",function(req,res){
    if (!ensureAdmin(res)) {
        return;
    }
    let bookid = parseInt(req.params.bid);
    book_detail_collection.remove({book_id: bookid},function(err,result){
        if(err) throw err;
        res.send("<script> alert('Book Detail Deleted Successfully'); window.location.href='/admin_manage_book'; </script>")                            
    })
})

app.get("/edit_book/:bid",function(req,res){
    if (!ensureAdmin(res)) {
        return;
    }
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
    if (!ensureAdmin(res)) {
        return;
    }
    const {txtbid,txtname,txtdesc,selcat,txtprice} = req.body;
    
    if(!req.files || Object.keys(req.files).length ==0)
    {
        book_detail_collection.updateOne({book_id: parseInt(txtbid)},{$set: {book_name:txtname,category_id:parseInt(selcat),description:txtdesc,book_price: parseInt(txtprice)}},function(err1,result1){
            if(err1) throw err1;
            res.send("<script> alert('Book Detail Updated Successfully'); window.location.href='/admin_manage_book'; </script>")                                                    
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
                    res.send("<script> alert('Error In Book Detail Updation'); window.location.href='/admin_manage_book'; </script>")                                                            
                }else{
                    res.send("<script> alert('Book Detail Updated Successfully'); window.location.href='/admin_manage_book'; </script>")                                                    
                }
            })
            
        })
    }
})
