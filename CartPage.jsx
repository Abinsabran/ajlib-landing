import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Minus, Plus, Trash2, ShoppingBag } from 'lucide-react'

const CartPage = () => {
  const [cartItems, setCartItems] = useState([
    {
      id: 1,
      name: 'بوكسر كلاسيكي - أسود',
      price: 25,
      quantity: 2,
      size: 'L',
      image: '/api/placeholder/150/150'
    },
    {
      id: 2,
      name: 'بوكسر رياضي - أزرق داكن',
      price: 30,
      quantity: 1,
      size: 'M',
      image: '/api/placeholder/150/150'
    },
    {
      id: 3,
      name: 'بوكسر فاخر - رمادي',
      price: 35,
      quantity: 1,
      size: 'XL',
      image: '/api/placeholder/150/150'
    }
  ])

  const [promoCode, setPromoCode] = useState('')
  const [discount, setDiscount] = useState(0)

  const updateQuantity = (id, newQuantity) => {
    if (newQuantity === 0) {
      removeItem(id)
      return
    }
    setCartItems(cartItems.map(item => 
      item.id === id ? { ...item, quantity: newQuantity } : item
    ))
  }

  const removeItem = (id) => {
    setCartItems(cartItems.filter(item => item.id !== id))
  }

  const applyPromoCode = () => {
    if (promoCode === 'SAVE10') {
      setDiscount(10)
    } else if (promoCode === 'WELCOME20') {
      setDiscount(20)
    } else {
      setDiscount(0)
    }
  }

  const subtotal = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0)
  const shipping = subtotal > 100 ? 0 : 15
  const discountAmount = (subtotal * discount) / 100
  const total = subtotal + shipping - discountAmount

  if (cartItems.length === 0) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <ShoppingBag className="h-24 w-24 mx-auto text-muted-foreground mb-6" />
        <h2 className="text-2xl font-bold mb-4">سلة التسوق فارغة</h2>
        <p className="text-muted-foreground mb-8">
          لم تقم بإضافة أي منتجات إلى سلة التسوق بعد
        </p>
        <Button size="lg">
          ابدأ التسوق الآن
        </Button>
      </div>
    )
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-8">سلة التسوق</h1>
      
      <div className="grid lg:grid-cols-3 gap-8">
        {/* Cart Items */}
        <div className="lg:col-span-2">
          <Card>
            <CardContent className="p-6">
              <div className="space-y-6">
                {cartItems.map((item) => (
                  <div key={item.id} className="flex items-center space-x-4 pb-6 border-b last:border-b-0">
                    <div className="w-20 h-20 bg-secondary/20 rounded-lg overflow-hidden">
                      <img
                        src={item.image}
                        alt={item.name}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    
                    <div className="flex-1">
                      <h3 className="font-semibold">{item.name}</h3>
                      <p className="text-sm text-muted-foreground">المقاس: {item.size}</p>
                      <p className="text-lg font-bold text-primary mt-1">
                        {item.price} درهم
                      </p>
                    </div>
                    
                    <div className="flex items-center space-x-2">
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => updateQuantity(item.id, item.quantity - 1)}
                      >
                        <Minus className="h-4 w-4" />
                      </Button>
                      <span className="w-12 text-center font-semibold">
                        {item.quantity}
                      </span>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => updateQuantity(item.id, item.quantity + 1)}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                    
                    <div className="text-right">
                      <p className="font-bold">
                        {item.price * item.quantity} ريال
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeItem(item.id)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Order Summary */}
        <div className="lg:col-span-1">
          <Card>
            <CardContent className="p-6">
              <h2 className="text-xl font-semibold mb-6">ملخص الطلب</h2>
              
              {/* Promo Code */}
              <div className="mb-6">
                <label className="block text-sm font-medium mb-2">
                  كود الخصم
                </label>
                <div className="flex space-x-2">
                  <Input
                    placeholder="أدخل كود الخصم"
                    value={promoCode}
                    onChange={(e) => setPromoCode(e.target.value)}
                    className="flex-1"
                  />
                  <Button onClick={applyPromoCode} variant="outline">
                    تطبيق
                  </Button>
                </div>
                {discount > 0 && (
                  <p className="text-sm text-green-600 mt-2">
                    تم تطبيق خصم {discount}%
                  </p>
                )}
              </div>

              <Separator className="my-4" />

              {/* Price Breakdown */}
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span>المجموع الفرعي</span>
                  <span>{subtotal} درهم</span>
                </div>
                
                <div className="flex justify-between">
                  <span>الشحن</span>
                  <span>
                    {shipping === 0 ? 'مجاني' : `${shipping} درهم`}
                  </span>
                </div>
                
                {discount > 0 && (
                  <div className="flex justify-between text-green-600">
                    <span>الخصم ({discount}%)</span>
                    <span>-{discountAmount} درهم</span>
                  </div>
                )}
                
                <Separator />
                
                <div className="flex justify-between text-lg font-bold">
                  <span>المجموع الكلي</span>
                  <span>{total} درهم</span>
                </div>
              </div>

              <Button className="w-full mt-6" size="lg">
                متابعة إلى الدفع
              </Button>

              <div className="mt-4 text-center">
                <Button variant="outline" className="w-full">
                  متابعة التسوق
                </Button>
              </div>

              {/* Shipping Info */}
              <div className="mt-6 p-4 bg-secondary/20 rounded-lg">
                <p className="text-sm text-center">
                  🚚 شحن مجاني للطلبات أكثر من 100 درهم
                </p>
                {subtotal <= 100 && (
                  <p className="text-sm text-center mt-1 text-muted-foreground">
                    أضف {100 - subtotal} درهم للحصول على شحن مجاني
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

export default CartPage

