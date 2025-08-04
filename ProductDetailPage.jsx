import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Star, ShoppingCart, Heart, Share2, Minus, Plus } from 'lucide-react'

const ProductDetailPage = () => {
  const [selectedSize, setSelectedSize] = useState('M')
  const [selectedColor, setSelectedColor] = useState('أسود')
  const [quantity, setQuantity] = useState(1)
  const [selectedImage, setSelectedImage] = useState(0)

  // بيانات المنتج
  const product = {
    id: 1,
    name: 'بوكسر كلاسيكي - أسود',
    price: 25,
    originalPrice: 35,
    rating: 4.8,
    reviews: 124,
    inStock: true,
    images: [
      '/api/placeholder/500/500',
      '/api/placeholder/500/500',
      '/api/placeholder/500/500',
      '/api/placeholder/500/500'
    ],
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
    colors: ['أسود', 'أبيض', 'رمادي'],
    description: 'بوكسر مصنوع من القطن الطبيعي 100% يوفر راحة استثنائية طوال اليوم. تصميم كلاسيكي بخياطة عالية الجودة ومقاوم للانكماش.',
    features: [
      'قطن طبيعي 100%',
      'مقاوم للانكماش',
      'خياطة مسطحة لمنع الاحتكاك',
      'حزام مرن مريح',
      'قابل للغسل في الغسالة'
    ],
    sizeGuide: {
      'S': '28-30',
      'M': '32-34',
      'L': '36-38',
      'XL': '40-42',
      'XXL': '44-46'
    }
  }

  // منتجات مشابهة
  const relatedProducts = [
    {
      id: 2,
      name: 'بوكسر رياضي - أزرق داكن',
      price: 30,
      image: '/api/placeholder/200/200',
      rating: 4.9
    },
    {
      id: 3,
      name: 'بوكسر فاخر - رمادي',
      price: 35,
      image: '/api/placeholder/200/200',
      rating: 4.7
    },
    {
      id: 4,
      name: 'عبوة متعددة الألوان',
      price: 75,
      image: '/api/placeholder/200/200',
      rating: 4.9
    }
  ]

  const updateQuantity = (change) => {
    const newQuantity = quantity + change
    if (newQuantity >= 1 && newQuantity <= 10) {
      setQuantity(newQuantity)
    }
  }

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Breadcrumb */}
      <nav className="text-sm text-muted-foreground mb-6">
        <span>الرئيسية</span> / <span>المنتجات</span> / <span className="text-foreground">{product.name}</span>
      </nav>

      <div className="grid lg:grid-cols-2 gap-12">
        {/* Product Images */}
        <div>
          <div className="aspect-square bg-secondary/20 rounded-lg overflow-hidden mb-4">
            <img
              src={product.images[selectedImage]}
              alt={product.name}
              className="w-full h-full object-cover"
            />
          </div>
          <div className="grid grid-cols-4 gap-2">
            {product.images.map((image, index) => (
              <button
                key={index}
                onClick={() => setSelectedImage(index)}
                className={`aspect-square bg-secondary/20 rounded-lg overflow-hidden border-2 ${
                  selectedImage === index ? 'border-primary' : 'border-transparent'
                }`}
              >
                <img
                  src={image}
                  alt={`${product.name} ${index + 1}`}
                  className="w-full h-full object-cover"
                />
              </button>
            ))}
          </div>
        </div>

        {/* Product Info */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="secondary">متوفر</Badge>
            <Badge variant="outline">جديد</Badge>
          </div>

          <h1 className="text-3xl font-bold mb-4">{product.name}</h1>

          <div className="flex items-center mb-4">
            <div className="flex items-center">
              {[...Array(5)].map((_, i) => (
                <Star
                  key={i}
                  className={`h-5 w-5 ${
                    i < Math.floor(product.rating)
                      ? 'text-yellow-400 fill-current'
                      : 'text-gray-300'
                  }`}
                />
              ))}
            </div>
            <span className="mr-2 text-muted-foreground">
              {product.rating} ({product.reviews} تقييم)
            </span>
          </div>

          <div className="flex items-center gap-4 mb-6">
            <span className="text-3xl font-bold text-primary">
              {product.price} درهم
            </span>
            {product.originalPrice && (
              <span className="text-xl text-muted-foreground line-through">
                {product.originalPrice} درهم
              </span>
            )}
          </div>

          <p className="text-muted-foreground mb-6">
            {product.description}
          </p>

          {/* Size Selection */}
          <div className="mb-6">
            <h3 className="font-semibold mb-3">المقاس</h3>
            <div className="flex gap-2">
              {product.sizes.map((size) => (
                <Button
                  key={size}
                  variant={selectedSize === size ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSelectedSize(size)}
                >
                  {size}
                </Button>
              ))}
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              دليل المقاسات: {product.sizeGuide[selectedSize]}
            </p>
          </div>

          {/* Color Selection */}
          <div className="mb-6">
            <h3 className="font-semibold mb-3">اللون</h3>
            <div className="flex gap-2">
              {product.colors.map((color) => (
                <Button
                  key={color}
                  variant={selectedColor === color ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSelectedColor(color)}
                >
                  {color}
                </Button>
              ))}
            </div>
          </div>

          {/* Quantity */}
          <div className="mb-6">
            <h3 className="font-semibold mb-3">الكمية</h3>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={() => updateQuantity(-1)}
                disabled={quantity <= 1}
              >
                <Minus className="h-4 w-4" />
              </Button>
              <span className="w-12 text-center font-semibold">
                {quantity}
              </span>
              <Button
                variant="outline"
                size="icon"
                onClick={() => updateQuantity(1)}
                disabled={quantity >= 10}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-4 mb-6">
            <Button size="lg" className="flex-1">
              <ShoppingCart className="h-5 w-5 ml-2" />
              أضف إلى السلة
            </Button>
            <Button variant="outline" size="lg">
              <Heart className="h-5 w-5" />
            </Button>
            <Button variant="outline" size="lg">
              <Share2 className="h-5 w-5" />
            </Button>
          </div>

          {/* Features */}
          <Card>
            <CardContent className="p-4">
              <h3 className="font-semibold mb-3">المميزات</h3>
              <ul className="space-y-2">
                {product.features.map((feature, index) => (
                  <li key={index} className="flex items-center">
                    <span className="w-2 h-2 bg-primary rounded-full ml-2"></span>
                    {feature}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Related Products */}
      <section className="mt-16">
        <h2 className="text-2xl font-bold mb-8">منتجات مشابهة</h2>
        <div className="grid md:grid-cols-3 gap-6">
          {relatedProducts.map((relatedProduct) => (
            <Card key={relatedProduct.id} className="group hover:shadow-lg transition-shadow">
              <CardContent className="p-4">
                <div className="aspect-square bg-secondary/20 rounded-lg mb-4 overflow-hidden">
                  <img
                    src={relatedProduct.image}
                    alt={relatedProduct.name}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                  />
                </div>
                <h3 className="font-semibold mb-2">{relatedProduct.name}</h3>
                <div className="flex items-center justify-between">
                  <span className="text-xl font-bold text-primary">
                    {relatedProduct.price} درهم
                  </span>
                  <div className="flex items-center">
                    <Star className="h-4 w-4 text-yellow-400 fill-current" />
                    <span className="text-sm mr-1">{relatedProduct.rating}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  )
}

export default ProductDetailPage

