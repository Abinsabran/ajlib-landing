import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Star, ShoppingCart, Truck, Shield, RefreshCw } from 'lucide-react'

const HomePage = () => {
  const [featuredProducts, setFeaturedProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetchFeaturedProducts()
  }, [])

  const fetchFeaturedProducts = async () => {
    try {
      setLoading(true)
      const response = await fetch('https://77h9ikcwzz0p.manus.space/api/products/featured?limit=4')
      const data = await response.json()
      
      if (data.success) {
        setFeaturedProducts(data.products)
      } else {
        setError('فشل في تحميل المنتجات المميزة')
      }
    } catch (err) {
      setError('خطأ في الاتصال بالخادم')
      console.error('Error fetching featured products:', err)
    } finally {
      setLoading(false)
    }
  }

  const addToCart = async (productId) => {
    try {
      // إنشاء session_id مؤقت للمستخدمين غير المسجلين
      let sessionId = localStorage.getItem('cart_session_id')
      if (!sessionId) {
        sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
        localStorage.setItem('cart_session_id', sessionId)
      }

      const response = await fetch('https://77h9ikcwzz0p.manus.space/api/cart/add', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session_id: sessionId,
          product_id: productId,
          quantity: 1,
          size: 'M', // حجم افتراضي
          color: 'أسود' // لون افتراضي
        })
      })

      const data = await response.json()
      if (data.success) {
        alert('تم إضافة المنتج إلى السلة!')
        // يمكن إضافة تحديث عداد السلة هنا
      } else {
        alert('فشل في إضافة المنتج: ' + data.error)
      }
    } catch (err) {
      alert('خطأ في إضافة المنتج إلى السلة')
      console.error('Error adding to cart:', err)
    }
  }

  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <section className="bg-primary text-primary-foreground py-20">
        <div className="container mx-auto px-4 text-center">
          <h1 className="text-4xl md:text-6xl font-bold mb-6">
            ملابس داخلية فاخرة للرجل العصري
          </h1>
          <p className="text-xl md:text-2xl mb-8 text-primary-foreground/80">
            اكتشف مجموعتنا الجديدة من الملابس الداخلية عالية الجودة
          </p>
          <Link to="/products">
            <Button size="lg" variant="secondary" className="text-lg px-8 py-3">
              تسوق الآن
            </Button>
          </Link>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-16 bg-secondary/20">
        <div className="container mx-auto px-4">
          <div className="grid md:grid-cols-3 gap-8">
            <div className="text-center">
              <div className="bg-primary text-primary-foreground rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4">
                <Truck className="h-8 w-8" />
              </div>
              <h3 className="text-xl font-semibold mb-2">شحن مجاني</h3>
              <p className="text-muted-foreground">للطلبات أكثر من 100 درهم</p>
            </div>
            <div className="text-center">
              <div className="bg-primary text-primary-foreground rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4">
                <Star className="h-8 w-8" />
              </div>
              <h3 className="text-xl font-semibold mb-2">جودة عالية</h3>
              <p className="text-muted-foreground">منتجات مصنوعة من أجود الخامات</p>
            </div>
            <div className="text-center">
              <div className="bg-primary text-primary-foreground rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4">
                <Shield className="h-8 w-8" />
              </div>
              <h3 className="text-xl font-semibold mb-2">إرجاع مجاني</h3>
              <p className="text-muted-foreground">خلال 14 يوم من الشراء</p>
            </div>
          </div>
        </div>
      </section>

      {/* Featured Products */}
      <section className="py-16">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl font-bold text-center mb-12">المنتجات المميزة</h2>
          
          {loading && (
            <div className="flex justify-center items-center py-12">
              <RefreshCw className="h-8 w-8 animate-spin" />
              <span className="mr-2">جاري التحميل...</span>
            </div>
          )}

          {error && (
            <div className="text-center py-12">
              <p className="text-red-500 mb-4">{error}</p>
              <Button onClick={fetchFeaturedProducts} variant="outline">
                إعادة المحاولة
              </Button>
            </div>
          )}

          {!loading && !error && (
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
              {featuredProducts.map((product) => (
                <Card key={product.id} className="group hover:shadow-lg transition-shadow">
                  <CardContent className="p-4">
                    <div className="aspect-square bg-secondary/20 rounded-lg mb-4 overflow-hidden">
                      <img
                        src={product.images?.[0]?.image_url || '/api/placeholder/300/300'}
                        alt={product.name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                      />
                    </div>
                    <h3 className="font-semibold mb-2">{product.name}</h3>
                    <div className="flex items-center mb-2">
                      <div className="flex items-center">
                        {[...Array(5)].map((_, i) => (
                          <Star
                            key={i}
                            className={`h-4 w-4 ${
                              i < Math.floor(product.rating)
                                ? 'text-yellow-400 fill-current'
                                : 'text-gray-300'
                            }`}
                          />
                        ))}
                      </div>
                      <span className="text-sm text-muted-foreground mr-2">
                        ({product.review_count})
                      </span>
                    </div>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xl font-bold text-primary">
                          {product.price} درهم
                        </span>
                        {product.original_price && (
                          <span className="text-sm text-muted-foreground line-through">
                            {product.original_price} درهم
                          </span>
                        )}
                      </div>
                    </div>
                    <Button 
                      className="w-full" 
                      onClick={() => addToCart(product.id)}
                    >
                      <ShoppingCart className="h-4 w-4 ml-2" />
                      أضف للسلة
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          <div className="text-center mt-12">
            <Link to="/products">
              <Button size="lg" variant="outline">
                ابدأ التسوق الآن
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="bg-primary text-primary-foreground py-16">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold mb-4">
            انضم إلى آلاف العملاء الراضين
          </h2>
          <p className="text-xl mb-8 text-primary-foreground/80">
            احصل على أفضل تجربة تسوق للملابس الداخلية الفاخرة
          </p>
          <Link to="/products">
            <Button size="lg" variant="secondary" className="text-lg px-8 py-3">
              ابدأ التسوق الآن
            </Button>
          </Link>
        </div>
      </section>
    </div>
  )
}

export default HomePage

