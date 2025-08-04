from src.models.user import db
from datetime import datetime
from enum import Enum

class OrderStatus(Enum):
    PENDING = 'pending'
    CONFIRMED = 'confirmed'
    PROCESSING = 'processing'
    SHIPPED = 'shipped'
    DELIVERED = 'delivered'
    CANCELLED = 'cancelled'
    REFUNDED = 'refunded'

class PaymentStatus(Enum):
    PENDING = 'pending'
    PAID = 'paid'
    FAILED = 'failed'
    REFUNDED = 'refunded'

class Order(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    order_number = db.Column(db.String(50), unique=True, nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    
    # معلومات الشحن
    shipping_name = db.Column(db.String(100), nullable=False)
    shipping_email = db.Column(db.String(120), nullable=False)
    shipping_phone = db.Column(db.String(20), nullable=False)
    shipping_address = db.Column(db.Text, nullable=False)
    shipping_city = db.Column(db.String(100), nullable=False)
    shipping_postal_code = db.Column(db.String(20))
    
    # معلومات الفواتير (إذا كانت مختلفة عن الشحن)
    billing_name = db.Column(db.String(100))
    billing_email = db.Column(db.String(120))
    billing_phone = db.Column(db.String(20))
    billing_address = db.Column(db.Text)
    billing_city = db.Column(db.String(100))
    billing_postal_code = db.Column(db.String(20))
    
    # معلومات الأسعار
    subtotal = db.Column(db.Float, nullable=False)
    shipping_cost = db.Column(db.Float, default=0.0)
    tax_amount = db.Column(db.Float, default=0.0)
    discount_amount = db.Column(db.Float, default=0.0)
    total_amount = db.Column(db.Float, nullable=False)
    
    # حالة الطلب والدفع
    status = db.Column(db.Enum(OrderStatus), default=OrderStatus.PENDING)
    payment_status = db.Column(db.Enum(PaymentStatus), default=PaymentStatus.PENDING)
    payment_method = db.Column(db.String(50))
    
    # ملاحظات
    notes = db.Column(db.Text)
    admin_notes = db.Column(db.Text)
    
    # التواريخ
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    shipped_at = db.Column(db.DateTime)
    delivered_at = db.Column(db.DateTime)
    
    # العلاقات
    user = db.relationship('User', backref='orders')
    items = db.relationship('OrderItem', backref='order', lazy=True, cascade='all, delete-orphan')
    
    def to_dict(self):
        return {
            'id': self.id,
            'order_number': self.order_number,
            'user_id': self.user_id,
            'shipping_info': {
                'name': self.shipping_name,
                'email': self.shipping_email,
                'phone': self.shipping_phone,
                'address': self.shipping_address,
                'city': self.shipping_city,
                'postal_code': self.shipping_postal_code
            },
            'billing_info': {
                'name': self.billing_name,
                'email': self.billing_email,
                'phone': self.billing_phone,
                'address': self.billing_address,
                'city': self.billing_city,
                'postal_code': self.billing_postal_code
            } if self.billing_name else None,
            'pricing': {
                'subtotal': self.subtotal,
                'shipping_cost': self.shipping_cost,
                'tax_amount': self.tax_amount,
                'discount_amount': self.discount_amount,
                'total_amount': self.total_amount
            },
            'status': self.status.value if self.status else None,
            'payment_status': self.payment_status.value if self.payment_status else None,
            'payment_method': self.payment_method,
            'notes': self.notes,
            'admin_notes': self.admin_notes,
            'items': [item.to_dict() for item in self.items],
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            'shipped_at': self.shipped_at.isoformat() if self.shipped_at else None,
            'delivered_at': self.delivered_at.isoformat() if self.delivered_at else None
        }

class OrderItem(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    order_id = db.Column(db.Integer, db.ForeignKey('order.id'), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey('product.id'), nullable=False)
    
    # معلومات المنتج وقت الطلب
    product_name = db.Column(db.String(200), nullable=False)
    product_sku = db.Column(db.String(100))
    quantity = db.Column(db.Integer, nullable=False)
    size = db.Column(db.String(10))
    color = db.Column(db.String(50))
    unit_price = db.Column(db.Float, nullable=False)
    total_price = db.Column(db.Float, nullable=False)
    
    # العلاقات
    product = db.relationship('Product', backref='order_items')
    
    def to_dict(self):
        return {
            'id': self.id,
            'order_id': self.order_id,
            'product_id': self.product_id,
            'product_name': self.product_name,
            'product_sku': self.product_sku,
            'quantity': self.quantity,
            'size': self.size,
            'color': self.color,
            'unit_price': self.unit_price,
            'total_price': self.total_price,
            'product': self.product.to_dict() if self.product else None
        }

