from src.models.user import db
from datetime import datetime

class Category(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    description = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    # العلاقة مع المنتجات
    products = db.relationship('Product', backref='category', lazy=True)
    
    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'description': self.description,
            'created_at': self.created_at.isoformat() if self.created_at else None
        }

class Product(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text)
    price = db.Column(db.Float, nullable=False)
    original_price = db.Column(db.Float)
    stock_quantity = db.Column(db.Integer, default=0)
    sku = db.Column(db.String(100), unique=True)
    
    # معلومات إضافية
    sizes = db.Column(db.String(200))  # JSON string للأحجام المتاحة
    colors = db.Column(db.String(200))  # JSON string للألوان المتاحة
    features = db.Column(db.Text)  # JSON string للمميزات
    
    # تقييمات
    rating = db.Column(db.Float, default=0.0)
    review_count = db.Column(db.Integer, default=0)
    
    # حالة المنتج
    is_active = db.Column(db.Boolean, default=True)
    is_featured = db.Column(db.Boolean, default=False)
    
    # التواريخ
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # العلاقات
    category_id = db.Column(db.Integer, db.ForeignKey('category.id'))
    images = db.relationship('ProductImage', backref='product', lazy=True, cascade='all, delete-orphan')
    
    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'description': self.description,
            'price': self.price,
            'original_price': self.original_price,
            'stock_quantity': self.stock_quantity,
            'sku': self.sku,
            'sizes': self.sizes,
            'colors': self.colors,
            'features': self.features,
            'rating': self.rating,
            'review_count': self.review_count,
            'is_active': self.is_active,
            'is_featured': self.is_featured,
            'category_id': self.category_id,
            'category': self.category.to_dict() if self.category else None,
            'images': [img.to_dict() for img in self.images],
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None
        }

class ProductImage(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    product_id = db.Column(db.Integer, db.ForeignKey('product.id'), nullable=False)
    image_url = db.Column(db.String(500), nullable=False)
    alt_text = db.Column(db.String(200))
    is_primary = db.Column(db.Boolean, default=False)
    sort_order = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    def to_dict(self):
        return {
            'id': self.id,
            'product_id': self.product_id,
            'image_url': self.image_url,
            'alt_text': self.alt_text,
            'is_primary': self.is_primary,
            'sort_order': self.sort_order,
            'created_at': self.created_at.isoformat() if self.created_at else None
        }

