import os
import sys
# DON'T CHANGE THIS !!!
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from flask import Flask, send_from_directory
from flask_cors import CORS
from src.models.user import db
from src.models.product import Product, Category, ProductImage
from src.models.cart import Cart, CartItem
from src.models.order import Order, OrderItem
from src.routes.user import user_bp
from src.routes.product import product_bp
from src.routes.cart import cart_bp

app = Flask(__name__, static_folder=os.path.join(os.path.dirname(__file__), 'static'))
app.config['SECRET_KEY'] = 'asdf#FGSgvasgf$5$WGT'

# تمكين CORS للسماح بالطلبات من جميع المصادر
CORS(app, origins=['*'])

# تسجيل الـ blueprints
app.register_blueprint(user_bp, url_prefix='/api')
app.register_blueprint(product_bp, url_prefix='/api')
app.register_blueprint(cart_bp, url_prefix='/api')

# إعداد قاعدة البيانات
app.config['SQLALCHEMY_DATABASE_URI'] = f"sqlite:///{os.path.join(os.path.dirname(__file__), 'database', 'app.db')}"
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
db.init_app(app)

with app.app_context():
    db.create_all()
    
    # إضافة بيانات تجريبية إذا لم تكن موجودة
    if True:  # إعادة إنشاء البيانات في كل مرة
        # حذف البيانات القديمة
        ProductImage.query.delete()
        Product.query.delete()
        Category.query.delete()
        db.session.commit()
        # إضافة فئات
        categories = [
            Category(name='كلاسيكي | Classic', description='ملابس داخلية كلاسيكية مريحة | Comfortable classic underwear'),
            Category(name='رياضي | Sports', description='ملابس داخلية رياضية عالية الأداء | High-performance sports underwear'),
            Category(name='فاخر | Premium', description='ملابس داخلية فاخرة من أجود الخامات | Premium underwear from finest materials'),
            Category(name='عبوات | Packs', description='عبوات متعددة القطع بأسعار مميزة | Multi-piece packs at special prices')
        ]
        
        for category in categories:
            db.session.add(category)
        
        db.session.commit()
        
        # إضافة منتجات حقيقية
        products = [
            {
                'name': 'بوكسر أسود | Black Boxer',
                'description': 'بوكسر مصنوع من أجود الخامات يوفر راحة استثنائية طوال اليوم. تصميم عصري بخياطة عالية الجودة ومقاوم للانكماش. | Premium quality boxer made from finest materials providing exceptional comfort all day. Modern design with high-quality stitching and shrink-resistant.',
                'price': 18.5,
                'stock_quantity': 100,
                'sku': 'BOX-BLK-001',
                'sizes': '["M", "L", "XL", "XXL"]',
                'colors': '["أسود | Black"]',
                'features': '["خامة عالية الجودة | Premium Material", "مقاوم للانكماش | Shrink Resistant", "خياطة مسطحة | Flat Seams", "حزام مرن مريح | Comfortable Elastic Band"]',
                'rating': 4.8,
                'review_count': 124,
                'is_featured': True,
                'category_id': 1
            },
            {
                'name': 'بوكسر أبيض | White Boxer',
                'description': 'بوكسر كلاسيكي باللون الأبيض مصنوع من القطن الطبيعي. مثالي للاستخدام اليومي ويوفر راحة فائقة. | Classic white boxer made from natural cotton. Perfect for daily use and provides superior comfort.',
                'price': 18.5,
                'stock_quantity': 100,
                'sku': 'BOX-WHT-002',
                'sizes': '["M", "L", "XL", "XXL"]',
                'colors': '["أبيض | White"]',
                'features': '["قطن طبيعي | Natural Cotton", "لون كلاسيكي | Classic Color", "مريح للاستخدام اليومي | Comfortable for Daily Use", "سهل العناية | Easy Care"]',
                'rating': 4.7,
                'review_count': 98,
                'is_featured': True,
                'category_id': 1
            },
            {
                'name': 'بوكسر رصاصي | Gray Boxer',
                'description': 'بوكسر أنيق باللون الرصاصي يجمع بين الأناقة والراحة. خامة مرنة توفر حرية حركة ممتازة. | Elegant gray boxer combining style and comfort. Flexible material providing excellent freedom of movement.',
                'price': 18.5,
                'stock_quantity': 100,
                'sku': 'BOX-GRY-003',
                'sizes': '["M", "L", "XL", "XXL"]',
                'colors': '["رصاصي | Gray"]',
                'features': '["خامة مرنة | Flexible Material", "تصميم أنيق | Elegant Design", "حرية حركة | Freedom of Movement", "مقاوم للتمدد | Stretch Resistant"]',
                'rating': 4.9,
                'review_count': 156,
                'is_featured': True,
                'category_id': 1
            },
            {
                'name': 'بوكسر أزرق غامق | Navy Blue Boxer',
                'description': 'بوكسر رياضي باللون الأزرق الغامق مصمم خصيصاً للأنشطة الرياضية. خامة تمتص الرطوبة وتوفر تهوية ممتازة. | Sports navy blue boxer specially designed for athletic activities. Moisture-wicking fabric with excellent ventilation.',
                'price': 18.5,
                'stock_quantity': 100,
                'sku': 'BOX-NVY-004',
                'sizes': '["M", "L", "XL", "XXL"]',
                'colors': '["أزرق غامق | Navy Blue"]',
                'features': '["خامة رياضية | Athletic Material", "مقاوم للرطوبة | Moisture Resistant", "تهوية ممتازة | Excellent Ventilation", "مرونة عالية | High Flexibility"]',
                'rating': 4.8,
                'review_count': 203,
                'is_featured': True,
                'category_id': 2
            }
        ]
        
        for product_data in products:
            product = Product(**product_data)
            db.session.add(product)
        
        db.session.commit()
        
        # إضافة صور المنتجات
        product_images = [
            {'product_id': 1, 'image_url': '/images/products/boxer-black.jpg', 'alt_text': 'بوكسر أسود | Black Boxer', 'is_primary': True},
            {'product_id': 2, 'image_url': '/images/products/boxer-white.jpg', 'alt_text': 'بوكسر أبيض | White Boxer', 'is_primary': True},
            {'product_id': 3, 'image_url': '/images/products/boxer-gray.jpg', 'alt_text': 'بوكسر رصاصي | Gray Boxer', 'is_primary': True},
            {'product_id': 4, 'image_url': '/images/products/boxer-navy.jpg', 'alt_text': 'بوكسر أزرق غامق | Navy Blue Boxer', 'is_primary': True}
        ]
        
        for img_data in product_images:
            image = ProductImage(**img_data)
            db.session.add(image)
        
        db.session.commit()

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve(path):
    static_folder_path = app.static_folder
    if static_folder_path is None:
            return "Static folder not configured", 404

    if path != "" and os.path.exists(os.path.join(static_folder_path, path)):
        return send_from_directory(static_folder_path, path)
    else:
        index_path = os.path.join(static_folder_path, 'index.html')
        if os.path.exists(index_path):
            return send_from_directory(static_folder_path, 'index.html')
        else:
            return "index.html not found", 404


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
