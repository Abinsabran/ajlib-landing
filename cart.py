from src.models.user import db
from datetime import datetime

class Cart(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    session_id = db.Column(db.String(100))  # للمستخدمين غير المسجلين
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # العلاقات
    items = db.relationship('CartItem', backref='cart', lazy=True, cascade='all, delete-orphan')
    user = db.relationship('User', backref='carts')
    
    def get_total(self):
        return sum(item.get_subtotal() for item in self.items)
    
    def get_item_count(self):
        return sum(item.quantity for item in self.items)
    
    def to_dict(self):
        return {
            'id': self.id,
            'user_id': self.user_id,
            'session_id': self.session_id,
            'items': [item.to_dict() for item in self.items],
            'total': self.get_total(),
            'item_count': self.get_item_count(),
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None
        }

class CartItem(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    cart_id = db.Column(db.Integer, db.ForeignKey('cart.id'), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey('product.id'), nullable=False)
    quantity = db.Column(db.Integer, nullable=False, default=1)
    size = db.Column(db.String(10))
    color = db.Column(db.String(50))
    price = db.Column(db.Float, nullable=False)  # سعر المنتج وقت الإضافة
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # العلاقات
    product = db.relationship('Product', backref='cart_items')
    
    def get_subtotal(self):
        return self.price * self.quantity
    
    def to_dict(self):
        return {
            'id': self.id,
            'cart_id': self.cart_id,
            'product_id': self.product_id,
            'product': self.product.to_dict() if self.product else None,
            'quantity': self.quantity,
            'size': self.size,
            'color': self.color,
            'price': self.price,
            'subtotal': self.get_subtotal(),
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None
        }

